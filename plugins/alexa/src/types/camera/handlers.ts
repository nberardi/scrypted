import { ObjectDetector, PanTiltZoom, RTCAVSignalingSetup, RTCSessionControl, RTCSignalingChannel, RTCSignalingOptions, RTCSignalingSendIceCandidate, RTCSignalingSession, ScryptedDevice } from "@scrypted/sdk";
import { supportedTypes } from "..";
import { v4 as createMessageId } from 'uuid';
import { AlexaHttpResponse, sendDeviceResponse } from "../../common";
import { alexaDeviceHandlers } from "../../handlers";
import { Response, WebRTCAnswerGeneratedForSessionEvent, WebRTCSessionConnectedEvent, WebRTCSessionDisconnectedEvent } from '../../alexa'

export class AlexaSignalingSession implements RTCSignalingSession {
    constructor(public response: AlexaHttpResponse, public directive: any) {
    }

    async getOptions(): Promise<RTCSignalingOptions> {
        return {
            proxy: false,
            offer: {
                type: 'offer',
                sdp: this.directive.payload.offer.value,
            },
            disableTrickle: true,
        }
    }

    async createLocalDescription(type: "offer" | "answer", setup: RTCAVSignalingSetup, sendIceCandidate: RTCSignalingSendIceCandidate): Promise<RTCSessionDescriptionInit> {
        if (type !== 'offer')
            throw new Error('Alexa only supports RTC offer');

        if (sendIceCandidate)
            throw new Error("Alexa does not support trickle ICE");

        return {
            type: type,
            sdp: this.directive.payload.offer.value,
        }
    }

    async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
        throw new Error("Alexa does not support trickle ICE");
    }

    async setRemoteDescription(description: RTCSessionDescriptionInit, setup: RTCAVSignalingSetup): Promise<void> {

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

        this.response.send(data);
    }
}

const sessionCache = new Map<string, RTCSessionControl>();

alexaDeviceHandlers.set('Alexa.RTCSessionController/InitiateSessionWithOffer', async (request, response, directive: any, device: ScryptedDevice & RTCSignalingChannel) => {
    const { header, endpoint, payload } = directive;
    const { sessionId } = payload;
    
    const session = new AlexaSignalingSession(response, directive);
    const control = await device.startRTCSignalingSession(session);
    control.setPlayback({
        audio: true,
        video: false,
    })

    sessionCache.set(sessionId, control);
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
    
    const session = sessionCache.get(sessionId);
    if (session) {
        sessionCache.delete(sessionId);
        await session.endSession();
    }
    
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
    const detectionTypes = await device.getObjectTypes();

    const data: Response = {
        "event": {
            header,
            endpoint,
            payload: {}
        },
        "context": {
            "properties": [{
                    "namespace": "Alexa.SmartVision.ObjectDetectionSensor",
                    "name": "objectDetectionClasses",
                    "value": detectionTypes.classes.map(type => ({
                        "imageNetClass": type
                    })),
                    timeOfSample: new Date().toISOString(),
                    uncertaintyInMilliseconds: 0
                }]
        }
    };

    data.event.header.name = "Response";
    data.event.header.messageId = createMessageId();

    sendDeviceResponse(data, response, device);
});

// Alexa, set Test Camera Pan to 20%
// Alexa, set Test Camera Tilt to 20%
// Alexa, set Test Camera Zoom to 100
alexaDeviceHandlers.set('Alexa.RangeController/SetRangeValue', async (request, response, directive: any, device: ScryptedDevice & PanTiltZoom) => {
    const { header, endpoint, payload } = directive;
    const { instance } = header;
    const { rangeValue } = payload;

    if (instance === 'Camera.Zoom') {
        const value = Math.abs(rangeValue) / 100.0;
        await device.ptzCommand({ zoom: value });
    }
    else if (instance === 'Camera.Pan') {
        const value = Math.abs(rangeValue) / 200.0 * (rangeValue < 0 ? -1 : 1);
        await device.ptzCommand({ pan: value });
    } 
    else if (instance === 'Camera.Tilt') {
        const value = Math.abs(rangeValue) / 200.0 * (rangeValue < 0 ? -1 : 1);
        await device.ptzCommand({ tilt: value });
    }

    const data: Response = {
        "event": {
            header,
            endpoint,
            payload: {}
        },
        "context": {
            "properties": [{
                namespace: "Alexa.RangeController",
                instance: instance,
                name: "rangeValue",
                value: rangeValue,
                timeOfSample: new Date().toISOString(),
                uncertaintyInMilliseconds: 0
            }]
        }
    };

    data.event.header.namespace = "Alexa";
    data.event.header.name = "Response";
    data.event.header.messageId = createMessageId();

    sendDeviceResponse(data, response, device);
});

alexaDeviceHandlers.set('Alexa.RangeController/AdjustRangeValue', async (request, response, directive: any, device: ScryptedDevice & PanTiltZoom) => {
    const { header, endpoint, payload } = directive;
    const { instance } = header;
    const { rangeValueDelta, rangeValueDeltaDefault } = payload;

    const rangeValue = (rangeValueDelta/100) * 1;

    if (instance === 'Camera.Zoom')
        await device.ptzCommand({ zoom: rangeValue });
    else if (instance === 'Camera.Pan')
        await device.ptzCommand({ pan: rangeValue });
    else if (instance === 'Camera.Tilt')
        await device.ptzCommand({ tilt: rangeValue });

    const data: Response = {
        "event": {
            header,
            endpoint,
            payload: {}
        },
        "context": {
            "properties": [{
                namespace: "Alexa.RangeController",
                instance: instance,
                name: "rangeValue",
                value: rangeValue,
                timeOfSample: new Date().toISOString(),
                uncertaintyInMilliseconds: 0
            }]
        }
    };

    data.event.header.namespace = "Alexa";
    data.event.header.name = "Response";
    data.event.header.messageId = createMessageId();

    sendDeviceResponse(data, response, device);
});