import { OnOff, ScryptedDevice, SecuritySystem, SecuritySystemMode } from "@scrypted/sdk";
import { supportedTypes } from "..";
import { sendDeviceResponse } from "../../common";
import { v4 as createMessageId } from 'uuid';
import { alexaDeviceHandlers } from "../../handlers";
import { Directive, Property, Response, SecurityPanelArmResponse, SecurityPanelArmResponsePayload } from "../../alexa";

function fromArmState(state: string): SecuritySystemMode {
    switch(state) {
        case 'ARMED_AWAY':
            return SecuritySystemMode.AwayArmed;
        case 'ARMED_STAY':
            return SecuritySystemMode.HomeArmed;
        case 'ARMED_NIGHT':
            return SecuritySystemMode.NightArmed;
        case 'DISARMED':
            return SecuritySystemMode.Disarmed;
    }
}

alexaDeviceHandlers.set('Alexa.SecurityPanelController/Arm', async (request, response, directive: Directive, device: ScryptedDevice & SecuritySystem) => {
    const supportedType = supportedTypes.get(device.type);
    if (!supportedType)
        return;

    const { header, endpoint, payload } = directive;
    const { armState } = payload as any;
    await device.armSecuritySystem(fromArmState(armState));

    const data : SecurityPanelArmResponse = {
        "event": {
            header: header as any,
            endpoint,
            payload: {
                exitDelayInSeconds: 60,
            } as SecurityPanelArmResponsePayload
        },
        "context": {
            "properties": [
                {
                    "namespace": "Alexa.SecurityPanelController",
                    "name": "armState",
                    "value": armState,
                    "timeOfSample": new Date().toISOString(),
                    "uncertaintyInMilliseconds": 0
                } as Property
            ]
        }
    };

    data.event.header.namespace = "Alexa.SecurityPanelController";
    data.event.header.name = "Arm.Response";
    data.event.header.messageId = createMessageId();

    sendDeviceResponse(data, response, device);
});

alexaDeviceHandlers.set('Alexa.SecurityPanelController/Disarm', async (request, response, directive: Directive, device: ScryptedDevice & SecuritySystem) => {
    const supportedType = supportedTypes.get(device.type);
    if (!supportedType)
        return;

    const { header, endpoint, payload } = directive;

    await device.disarmSecuritySystem();

    const data : Response = {
        "event": {
            header: header as any,
            endpoint,
            payload
        },
        "context": {
            "properties": [
                {
                    "namespace": "Alexa.SecurityPanelController",
                    "name": "armState",
                    "value": "DISARMED",
                    "timeOfSample": new Date().toISOString(),
                    "uncertaintyInMilliseconds": 0
                } as Property
            ]
        }
    };

    data.event.header.namespace = "Alexa";
    data.event.header.name = "Response";
    data.event.header.messageId = createMessageId();

    sendDeviceResponse(data, response, device);
});