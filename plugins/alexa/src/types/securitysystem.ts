import { EventDetails, FloodSensor, ScryptedDevice, ScryptedDeviceType, ScryptedInterface, SecuritySystem, SecuritySystemMode } from "@scrypted/sdk";
import { DiscoveryEndpoint, DiscoveryCapability, ChangeReport, Report, StateReport, DisplayCategory, ChangePayload, Property } from "../alexa";
import { supportedTypes } from ".";

function getArmState(mode: SecuritySystemMode): string {
    switch(mode) {
        case SecuritySystemMode.AwayArmed:
            return 'ARMED_AWAY';
        case SecuritySystemMode.HomeArmed:
            return 'ARMED_STAY';
        case SecuritySystemMode.NightArmed:
            return 'ARMED_NIGHT';
        case SecuritySystemMode.Disarmed:
            return 'DISARMED';
    }
}

const states = new Map<string, any>();

function getState<T>(device: ScryptedDevice, property: string): T {
    const state: T = states.get(device.id + '_' + property);
    return state;
}

function setState(device: ScryptedDevice, property: string, state: any) {
    states.set(device.id + '_' + property, state);
}

supportedTypes.set(ScryptedDeviceType.SecuritySystem, {
    async discover(device: ScryptedDevice & SecuritySystem): Promise<Partial<DiscoveryEndpoint>> {
        const capabilities: DiscoveryCapability[] = [];
        const displayCategories: DisplayCategory[] = [];

        if (!device.interfaces.includes(ScryptedInterface.SecuritySystem))
            return;

        const supportedModes = device.securitySystemState.supportedModes;
        const supportedTypes = [];

        //{
        //    "name": "fireAlarm"
        //},
        //{
        //    "name": "carbonMonoxideAlarm"
        //}

        if (device.interfaces.includes(ScryptedInterface.SecuritySystem))
            supportedTypes.push("armState", "burglaryAlarm");
        
        if (device.interfaces.includes(ScryptedInterface.FloodSensor))
            supportedTypes.push("waterAlarm");

        capabilities.push(
            {
                "type": "AlexaInterface",
                "interface": "Alexa.SecurityPanelController",
                "version": "3",
                "properties": {
                    "supported": supportedTypes.map(type => {
                        return {
                            "name": type
                        }
                    }),
                    "proactivelyReported": true,
                    "retrievable": true
                },
                "configuration": {
                    "supportedArmStates": supportedModes.map(mode => {
                        return {
                            "value": getArmState(mode)
                        }
                    }),
                    "supportedAuthorizationTypes": [
//                          {
//                            "type": "FOUR_DIGIT_PIN"
//                          }
                    ]
                }
                } as DiscoveryCapability
        );

        displayCategories.push('SECURITY_PANEL');

        return {
            displayCategories,
            capabilities
        }
    },
    async sendReport(eventSource: ScryptedDevice & SecuritySystem & FloodSensor): Promise<Partial<Report>> {
        let data = {
            context: {
                properties: []
            }
        } as Partial<StateReport>;
    
        if (eventSource.interfaces.includes(ScryptedInterface.SecuritySystem)) {
            setState(eventSource, 'mode', eventSource.securitySystemState.mode);
            setState(eventSource, 'triggered', eventSource.securitySystemState.triggered);

            data.context.properties.push({
                "namespace": "Alexa.SecurityPanelController",
                "name": "armState",
                "value": getArmState(eventSource.securitySystemState.mode),
                "timeOfSample": new Date().toISOString(),
                "uncertaintyInMilliseconds": 0
            } as Property);

            data.context.properties.push({
                "namespace": "Alexa.SecurityPanelController",
                "name": "burglaryAlarm",
                "value": {
                    "value": eventSource.securitySystemState.triggered ? "ALARM" : "OK",
                },
                "timeOfSample": new Date().toISOString(),
                "uncertaintyInMilliseconds": 0
            } as Property);
        }
    
        if (eventSource.interfaces.includes(ScryptedInterface.FloodSensor)) {
            data.context.properties.push({
                "namespace": "Alexa.SecurityPanelController",
                "name": "waterAlarm",
                "value": {
                    "value": eventSource.flooded ? "ALARM" : "OK",
                },
                "timeOfSample": new Date().toISOString(),
                "uncertaintyInMilliseconds": 0
            } as Property);
        }

        return data;
    },
    async sendEvent(eventSource: ScryptedDevice & SecuritySystem & FloodSensor, eventDetails: EventDetails, eventData): Promise<Partial<Report>> {    
        let data = {
            event: {
                payload: {}
            },
            context: {
                properties: []
            }
        } as Partial<ChangeReport>;

        let eventState: string;

        if (eventDetails.eventInterface === ScryptedInterface.SecuritySystem && eventDetails.property === 'securitySystemState') {
            let lastMode: string = getState<string>(eventSource, 'mode');
            let lastSecurityTriggered: boolean = getState<boolean>(eventSource, 'triggered');
            
            // if both are empty assume the trigger came from the trigger state, so that at least an alarm is setup off
            if (lastMode === undefined && lastSecurityTriggered === undefined) { 
                lastSecurityTriggered = !eventData.triggered;
                lastMode = eventData.mode;
            }

            if (eventData?.mode !== lastMode) { 
                setState(eventSource, 'mode', eventData.mode);
                eventState = "armState";
                data.event.payload = {
                    change: {
                        cause: {
                            type: "PHYSICAL_INTERACTION"
                        },
                        properties: [
                            {
                                "namespace": "Alexa.SecurityPanelController",
                                "name": "armState",
                                "value": getArmState(eventData),
                                "timeOfSample": new Date(eventDetails.eventTime).toISOString(),
                                "uncertaintyInMilliseconds": 0
                            } as Property
                        ]
                    }
                } as ChangePayload;
            }

            if (eventData?.triggered !== lastSecurityTriggered) {  
                setState(eventSource, 'triggered', eventData.triggered);
                eventState = "burglaryAlarm";
                data.event.payload = {
                    change: {
                        cause: {
                            type: "RULE_TRIGGER"
                        },
                        properties: [
                            {
                                "namespace": "Alexa.SecurityPanelController",
                                "name": "burglaryAlarm",
                                "value": {
                                    "value": eventData.triggered ? "ALARM" : "OK"
                                },
                                "timeOfSample": new Date(eventDetails.eventTime).toISOString(),
                                "uncertaintyInMilliseconds": 0
                            } as Property
                        ]
                    }
                } as ChangePayload;
            }
        }

        if (eventDetails.eventInterface === ScryptedInterface.FloodSensor) {
            eventState = "waterAlarm";
            data.event.payload = {
                change: {
                    cause: {
                        type: "RULE_TRIGGER"
                    },
                    properties: [
                        {
                            "namespace": "Alexa.SecurityPanelController",
                            "name": "waterAlarm",
                            "value": {
                                "value": eventData ? "ALARM" : "OK"
                            },
                            "timeOfSample": new Date(eventDetails.eventTime).toISOString(),
                            "uncertaintyInMilliseconds": 0
                        } as Property
                    ]
                }
            } as ChangePayload;
        }

        if (eventState !== "armState")
            data.context.properties.push({
                "namespace": "Alexa.SecurityPanelController",
                "name": "armState",
                "value": getArmState(eventSource.securitySystemState.mode),
                "timeOfSample": new Date().toISOString(),
                "uncertaintyInMilliseconds": 0
            } as Property);

        if (eventState !== "burglaryAlarm")
            data.context.properties.push({
                "namespace": "Alexa.SecurityPanelController",
                "name": "burglaryAlarm",
                "value": {
                    "value": eventSource.securitySystemState.triggered ? "ALARM" : "OK",
                },
                "timeOfSample": new Date().toISOString(),
                "uncertaintyInMilliseconds": 0
            } as Property);

        if (eventState !== "waterAlarm" && eventSource.interfaces.includes(ScryptedInterface.FloodSensor))
            data.context.properties.push({
                "namespace": "Alexa.SecurityPanelController",
                "name": "waterAlarm",
                "value": {
                    "value": eventSource.flooded ? "ALARM" : "OK",
                },
                "timeOfSample": new Date().toISOString(),
                "uncertaintyInMilliseconds": 0
            } as Property);
            
        return data;
    }
});
