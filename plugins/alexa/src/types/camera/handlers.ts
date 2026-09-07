import { ObjectDetector, RTCAVSignalingSetup, RTCSessionControl, RTCSignalingChannel, RTCSignalingOptions, RTCSignalingSendIceCandidate, RTCSignalingSession, ScryptedDevice } from "@scrypted/sdk";
import { supportedTypes } from "..";
import { v4 as createMessageId } from 'uuid';
import { AlexaHttpResponse, deviceErrorResponse, sendDeviceResponse } from "../../common";
import { alexaDeviceHandlers } from "../../handlers";
import { Response, WebRTCAnswerGeneratedForSessionEvent, WebRTCSessionConnectedEvent, WebRTCSessionDisconnectedEvent } from '../../alexa'
import { Deferred } from '@scrypted/common/src/deferred';
import { timeoutPromise } from '@scrypted/common/src/promise-utils';
import { setEnabledObjectDetectionClasses } from './capabilities';

export { setObjectDetectionClassesPersistence } from './capabilities';

// Whether Alexa camera sessions are allowed to use TURN relays. Set by the plugin from its
// storage settings (see main.ts). When true, TURN usage defers to the WebRTC plugin's own
// "Use TURN Servers" setting; when false, TURN is force-disabled for Alexa sessions only.
export let useTurnServer = true;
export function setUseTurnServer(value: boolean) {
    useTurnServer = value ?? true;
}

export class AlexaSignalingSession implements RTCSignalingSession {
    constructor(public response: AlexaHttpResponse, public directive: any) {
        this.options = this.createOptions();
        this.__proxy_props = { options: this.createOptions() };
    }

    __proxy_props: { options: RTCSignalingOptions; };
    options: RTCSignalingOptions;
    remoteDescription = new Deferred<void>();
    responded = false;

    async getOptions(): Promise<RTCSignalingOptions> {
        return this.options;
    }

    private createOptions() {
        const options: RTCSignalingOptions = {
            proxy: true,
            offer: {
                type: 'offer',
                sdp: this.directive.payload.offer.value,
            },
            disableTrickle: true,
            // Alexa sessions are proxied (Scrypted's server negotiates with the Alexa cloud) and
            // frequently cross NATs, where a TURN relay is the only path that connects. Since
            // trickle ICE is disabled, all candidates ship in the initial SDP, so omitting the
            // relay candidate leaves a NAT-blocked session with no fallback. By default we leave
            // TURN enabled, deferring to the WebRTC plugin's own "Use TURN Servers" setting (the
            // same behavior as the Google Home integration). Disabling it here force-disables TURN
            // for Alexa sessions only.
            disableTurn: !useTurnServer,
            // Alexa's InitiateSessionWithOffer directive carries no display hint (only sessionId
            // and the SDP offer), so we cap rather than match the endpoint. 1080p lets larger
            // displays (Echo Show 15, Fire TV) render sharply while the transcoder still clamps
            // width and falls back to 720p for sessions that can't negotiate H.264 High. We avoid
            // an uncapped (e.g. 4K) source stream, which would waste bandwidth and slow the
            // connection on smaller Echo devices.
            screen: {
                devicePixelRatio: 1,
                width: 1920,
                height: 1080
            }
        };

        return options;
    }

    async createLocalDescription(type: "offer" | "answer", setup: RTCAVSignalingSetup, sendIceCandidate: RTCSignalingSendIceCandidate): Promise<RTCSessionDescriptionInit> {
        if (type !== 'offer') {
            const e = new Error('Alexa only supports RTC offer');
            this.remoteDescription.reject(e);
            throw e;
        }

        if (sendIceCandidate) {
            const e = new Error("Alexa does not support trickle ICE");
            this.remoteDescription.reject(e);
            throw e;
        }

        return {
            type: type,
            sdp: this.directive.payload.offer.value,
        }
    }

    async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        throw new Error("Alexa does not support trickle ICE");
    }

    async setRemoteDescription(description: RTCSessionDescriptionInit, setup: RTCAVSignalingSetup): Promise<void> {
        // Do not send a second body if timeout/error already responded.
        if (this.responded || this.remoteDescription.finished)
            return;

        this.responded = true;

        const { header, endpoint, payload } = this.directive;

        const data: WebRTCAnswerGeneratedForSessionEvent = {
            "event": {
                header,
                endpoint,
                payload
            },
            context: undefined
        };

        data.event.header.name = "AnswerGeneratedForSession";
        data.event.header.messageId = createMessageId();

        data.event.payload.answer = {
            format: 'SDP',
            value: description.sdp,
        };

        this.remoteDescription.resolve();
        this.response.send(data);
    }
}

const sessionCache = new Map<string, RTCSessionControl>();

async function endRtcSession(control?: RTCSessionControl) {
    if (!control)
        return;
    try {
        await control.endSession();
    }
    catch {
    }
}

async function uncacheAndEndSession(sessionId: string) {
    const control = sessionCache.get(sessionId);
    if (!control)
        return;
    sessionCache.delete(sessionId);
    await endRtcSession(control);
}

alexaDeviceHandlers.set('Alexa.RTCSessionController/InitiateSessionWithOffer', async (request, response, directive: any, device: ScryptedDevice & RTCSignalingChannel) => {
    const { payload } = directive;
    const { sessionId } = payload;

    const session = new AlexaSignalingSession(response, directive);
    let control: RTCSessionControl | undefined;
    let failed = false;
    session.remoteDescription.promise.catch(() => {});

    try {
        // Alexa requires an SDP answer within 6 seconds of InitiateSessionWithOffer.
        const negotiation = (async () => {
            control = await device.startRTCSignalingSession(session);
            if (failed) {
                await endRtcSession(control);
                return;
            }
            control.setPlayback({
                audio: true,
                video: false,
            });
            await session.remoteDescription.promise;
        })();
        await timeoutPromise(6000, negotiation);
        // Swap before ending so SessionDisconnected always finds the live control
        // and a hung previous endSession cannot block or skip the cache insert.
        const previous = sessionCache.get(sessionId);
        sessionCache.set(sessionId, control);
        await endRtcSession(previous);
    }
    catch (e) {
        failed = true;
        console.error('Alexa RTC InitiateSessionWithOffer failed', e);

        if (!session.remoteDescription.finished)
            session.remoteDescription.reject(e instanceof Error ? e : new Error(String(e)));

        if (!session.responded) {
            session.responded = true;
            const data = deviceErrorResponse("INTERNAL_ERROR", "Unable to generate an SDP answer for the RTC session.", directive);
            // ErrorResponse for this directive must use namespace Alexa, not RTCSessionController.
            data.event.header.namespace = "Alexa";
            data.event.header.payloadVersion = "3";
            response.send(data);
        }

        await endRtcSession(control);
    }
});

alexaDeviceHandlers.set('Alexa.RTCSessionController/SessionConnected', async (request, response, directive: any, device: ScryptedDevice) => {
    const { header, endpoint, payload } = directive;
    const data: WebRTCSessionConnectedEvent = {
        "event": {
            header,
            endpoint,
            payload
        },
        context: undefined
    };

    data.event.header.messageId = createMessageId();

    response.send(data);
});

alexaDeviceHandlers.set('Alexa.RTCSessionController/SessionDisconnected', async (request, response, directive: any, device: ScryptedDevice) => {
    const { header, endpoint, payload } = directive;
    const { sessionId } = payload;

    await uncacheAndEndSession(sessionId);

    const data: WebRTCSessionDisconnectedEvent = {
        "event": {
            header,
            endpoint,
            payload
        },
        context: undefined
    };

    data.event.header.messageId = createMessageId();

    response.send(data);
});

alexaDeviceHandlers.set('Alexa.SmartVision.ObjectDetectionSensor/SetObjectDetectionClasses', async (request, response, directive: any, device: ScryptedDevice & ObjectDetector) => {
    const supportedType = supportedTypes.get(device.type);
    if (!supportedType)
        return;

    const { header, endpoint, payload } = directive;
    const requested = (payload?.objectDetectionClasses || [])
        .map((item: any) => item?.imageNetClass)
        .filter((imageNetClass: unknown): imageNetClass is string => typeof imageNetClass === 'string');
    setEnabledObjectDetectionClasses(device.id, requested);

    const data: Response = {
        "event": {
            header,
            endpoint,
            payload: {}
        }
    };

    data.event.header.namespace = "Alexa";
    data.event.header.name = "Response";
    data.event.header.payloadVersion = "3";
    data.event.header.messageId = createMessageId();

    sendDeviceResponse(data, response, device);
});