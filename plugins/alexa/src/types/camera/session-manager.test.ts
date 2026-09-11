import assert from 'node:assert/strict';
import test from 'node:test';
import type { RTCSessionControl } from '@scrypted/sdk';
import { createAnswerGeneratedForSession, RtcSessionManager } from './session-manager.ts';

function createControl() {
    let endCount = 0;
    const control = {
        async endSession() {
            endCount++;
        },
    } as RTCSessionControl;

    return {
        control,
        get endCount() {
            return endCount;
        },
    };
}

test('creates an answer-only RTC response payload without mutating the directive', () => {
    const directive = {
        header: {
            namespace: 'Alexa.RTCSessionController',
            name: 'InitiateSessionWithOffer',
            messageId: 'request-message-id',
            correlationToken: 'correlation-token',
            payloadVersion: '3',
        },
        endpoint: {
            endpointId: 'front-door',
        },
        payload: {
            sessionId: 'session-id',
            offer: {
                format: 'SDP',
                value: 'offer-sdp',
            },
        },
    };

    const response = createAnswerGeneratedForSession(directive, 'answer-sdp');

    assert.deepEqual(response.event.payload, {
        answer: {
            format: 'SDP',
            value: 'answer-sdp',
        },
    });
    assert.equal(response.event.header.namespace, 'Alexa.RTCSessionController');
    assert.equal(response.event.header.name, 'AnswerGeneratedForSession');
    assert.equal(response.event.header.correlationToken, 'correlation-token');
    assert.notEqual(response.event.header.messageId, directive.header.messageId);
    assert.equal(directive.header.name, 'InitiateSessionWithOffer');
    assert.deepEqual(Object.keys(directive.payload).sort(), ['offer', 'sessionId']);
});

test('ends only the session associated with the endpoint and session ID', async () => {
    const manager = new RtcSessionManager();
    const frontDoor = createControl();
    const backDoor = createControl();

    await manager.attach(manager.begin('front-door', 'shared-id'), frontDoor.control);
    await manager.attach(manager.begin('back-door', 'shared-id'), backDoor.control);
    await manager.end('front-door', 'shared-id');

    assert.equal(frontDoor.endCount, 1);
    assert.equal(backDoor.endCount, 0);
    assert.equal(manager.has('front-door', 'shared-id'), false);
    assert.equal(manager.has('back-door', 'shared-id'), true);

    await manager.endAll();
});

test('replacing a duplicate registration ends the previous control', async () => {
    const manager = new RtcSessionManager();
    const previous = createControl();
    const replacement = createControl();

    await manager.attach(manager.begin('front-door', 'session-id'), previous.control);
    const replacementRegistration = manager.begin('front-door', 'session-id');
    await manager.attach(replacementRegistration, replacement.control);

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(previous.endCount, 1);
    assert.equal(replacement.endCount, 0);

    await manager.endAll();
});

test('ends a control that arrives after its registration expires', async () => {
    const manager = new RtcSessionManager(10);
    const late = createControl();
    const registration = manager.begin('front-door', 'session-id');

    await new Promise(resolve => setTimeout(resolve, 20));
    const attached = await manager.attach(registration, late.control);

    assert.equal(attached, false);
    assert.equal(late.endCount, 1);
    assert.equal(manager.has('front-door', 'session-id'), false);
});
