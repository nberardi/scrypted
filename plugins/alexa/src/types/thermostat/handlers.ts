import { ScryptedDevice, TemperatureSetting, ThermostatMode } from "@scrypted/sdk";
import { supportedTypes } from "..";
import { sendDeviceResponse } from "../../common";
import { alexaDeviceHandlers } from "../../handlers";
import { v4 as createMessageId } from 'uuid';
import { Response } from "../../alexa";

function getScryptedThermostatMode (mode: string): ThermostatMode {
    switch (mode) {
        case "HEAT":
            return ThermostatMode.Heat;
        case "COOL":
            return ThermostatMode.Cool;
        case "AUTO":
            return ThermostatMode.Auto;
        case "ECO":
            return ThermostatMode.Eco;
        case "EM_HEAT":
            return ThermostatMode.EmergencyHeat;
        case "OFF":
            return ThermostatMode.Off;
    }
}

// https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-errorresponse.html#error-types
export function thermostatErrorResponse (errorType: string, errorMessage: string, directive: any): any {
    const { header, endpoint } = directive;
    const data = {
        "event": {
            header,
            endpoint,
            "payload": {
                "type": errorType,
                "message": errorMessage
            }
        }
    };

    data.event.header.namespace = "Alexa.ThermostatController";
    data.event.header.name = "ErrorResponse";
    data.event.header.messageId = createMessageId();

    return data;
}

async function sendTemperatureResponse (request, response, directive: any, device: ScryptedDevice & TemperatureSetting) {
    const supportedType = supportedTypes.get(device.type);
    if (!supportedType)
        return;

    const { header, endpoint, payload } = directive;
    const { targetSetpoint, lowerSetpoint, upperSetpoint, targetSetpointDelta } = payload;
    const { mode } = device.temperatureSetting;

    if (targetSetpoint && lowerSetpoint && upperSetpoint) {
        const setpointError = thermostatErrorResponse('TRIPLE_SETPOINTS_UNSUPPORTED', 'The thermostat doesn\'t support triple setpoints in the current mode.', directive);
        sendDeviceResponse(setpointError, response, device);
        return; 
    }

    if (mode !== ThermostatMode.Auto && mode !== ThermostatMode.HeatCool && (lowerSetpoint !== undefined || upperSetpoint !== undefined)) {
        const setpointError = thermostatErrorResponse('DUAL_SETPOINTS_UNSUPPORTED', 'The thermostat doesn\'t support dual setpoints in the current mode.', directive);
        sendDeviceResponse(setpointError, response, device);
        return; 
    }

    if (targetSetpoint && mode !== ThermostatMode.Auto && mode !== ThermostatMode.HeatCool) {
        const { value, scale } = targetSetpoint;
        await device.setTemperature({ setpoint: value });
    }

    if (targetSetpointDelta && mode !== ThermostatMode.Auto && mode !== ThermostatMode.HeatCool) {
        const { value, scale } = targetSetpoint;
        await device.setTemperature({ setpoint: device.temperatureSetting.setpoint + value });
    }

    if (lowerSetpoint && upperSetpoint && (mode === ThermostatMode.Auto || mode === ThermostatMode.HeatCool)) {
        const lowerValue = lowerSetpoint.value;
        const lowerScale = lowerSetpoint.scale;
        const upperValue = upperSetpoint.value;
        const upperScale = upperSetpoint.scale;
        await device.setTemperature({ setpoint: [lowerValue, upperValue] });
    }

    const report = await supportedType.setState(device, payload);
    const data = {
        "event": {
            header,
            endpoint,
            payload
        },
        context: report?.context
    } as Response;

    data.event.header.namespace = "Alexa";
    data.event.header.name = "Response";
    data.event.header.messageId = createMessageId();

    sendDeviceResponse(data, response, device);
}

async function sendModeResponse (request, response, directive: any, device: ScryptedDevice & TemperatureSetting) {
    const supportedType = supportedTypes.get(device.type);
    if (!supportedType)
        return;

    const { header, endpoint, payload } = directive;
    const { thermostatMode } = payload;
    const { availableModes } = device.temperatureSetting;
    const { value } = thermostatMode;

    const requestedMode = getScryptedThermostatMode(value);

    if (availableModes.includes(requestedMode)) {
        await device.setTemperature({ mode: requestedMode });
    } else {
        const setpointError = thermostatErrorResponse('UNSUPPORTED_THERMOSTAT_MODE', 'The thermostat doesn\'t support the specified mode.', directive);
        sendDeviceResponse(setpointError, response, device);
        return;
    }

    const report = await supportedType.setState(device, payload);
    const data = {
        "event": {
            header,
            endpoint,
            payload
        },
        context: report?.context
    } as Response;

    data.event.header.namespace = "Alexa";
    data.event.header.name = "Response";
    data.event.header.messageId = createMessageId();

    sendDeviceResponse(data, response, device);
}

alexaDeviceHandlers.set('Alexa.ThermostatController/SetTargetTemperature', sendTemperatureResponse);
alexaDeviceHandlers.set('Alexa.ThermostatController/AdjustTargetTemperature', sendTemperatureResponse); 

alexaDeviceHandlers.set('Alexa.ThermostatController/SetThermostatMode', sendModeResponse);

//alexaDeviceHandlers.set('Alexa.ThermostatController/ResumeSchedule', sendResponse); 
