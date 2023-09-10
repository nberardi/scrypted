import { OnOff, ScryptedDevice, ScryptedDeviceType, ScryptedInterface, TemperatureSetting, TemperatureUnit, Thermometer, ThermostatMode } from "@scrypted/sdk";
import { DiscoveryEndpoint, ChangeReport, Report, Property, ChangePayload, DiscoveryCapability, DisplayCategory } from "../alexa";
import { supportedTypes } from ".";

function getAlexaThermostatMode (mode: ThermostatMode): string {
    switch (mode) {
        case ThermostatMode.Heat:
            return "HEAT";
        case ThermostatMode.Cool:
            return "COOL";
        case ThermostatMode.Auto:
            return "AUTO";
        case ThermostatMode.Eco:
            return "ECO";
        case ThermostatMode.EmergencyHeat:
            return "EM_HEAT";
        case ThermostatMode.Off:
            return "OFF";
    }
} 

function getAlexaTemperatureUnit(unit: TemperatureUnit): string {
    switch (unit) {
        case TemperatureUnit.C:
            return "CELSIUS";
        case TemperatureUnit.F:
            return "FAHRENHEIT";
    }
}

supportedTypes.set(ScryptedDeviceType.Thermostat, {
    async discover(device: ScryptedDevice): Promise<Partial<DiscoveryEndpoint>> {
        if (!device.interfaces.includes(ScryptedInterface.OnOff))
            return;

        const capabilities: DiscoveryCapability[] = [];
        const displayCategories: DisplayCategory[] = [];

        if (device.interfaces.includes(ScryptedInterface.TemperatureSetting)) {
            let thermostat = device as any as TemperatureSetting;

            displayCategories.push('THERMOSTAT');
            capabilities.push({
                "type": "AlexaInterface",
                "interface": "Alexa.ThermostatController",
                "version": "3.2",
                "properties": {
                    "supported": [{
                            "name": "targetSetpoint"
                        },
                        {
                            "name": "lowerSetpoint"
                        },
                        {
                            "name": "upperSetpoint"
                        },
                        {
                            "name": "thermostatMode"
                        },
//                        {
//                            "name": "adaptiveRecoveryStatus"
//                        }
                    ],
                    "proactivelyReported": true,
                    "retrievable": true
                },
                "configuration": {
                    "supportedModes": [thermostat.temperatureSetting.availableModes.map(mode => {
                        return getAlexaThermostatMode(mode);
                    })]
                }
            });
        }

        if (device.interfaces.includes(ScryptedInterface.Thermometer)) {
            displayCategories.push('TEMPERATURE_SENSOR');
            capabilities.push({
                "type": "AlexaInterface",
                "interface": "Alexa.TemperatureSensor",
                "version": "3",
                "properties": {
                    "supported": [{
                        "name": "temperature"
                    }],
                    "proactivelyReported": true,
                    "retrievable": true
                }
            });
        }

        return {
            displayCategories,
            capabilities
        }
    },

    async sendReport(eventSource: ScryptedDevice & Thermometer & TemperatureSetting): Promise<Partial<Report>> {

        let { setpoint } = eventSource.temperatureSetting;

        let targetSetpoint, lowerSetpoint, upperSetpoint;

        if (setpoint) {
            if (typeof setpoint === 'number') {
                targetSetpoint = setpoint;
            }
            else {
                upperSetpoint = Math.max(setpoint[0], setpoint[1]);
                lowerSetpoint = Math.min(setpoint[0], setpoint[1]);
            }
        }

        let properties = [];

        properties.push({
                        "namespace": "Alexa.ThermostatController",
                        "name": "thermostatMode",
                        "value": getAlexaThermostatMode(eventSource.temperatureSetting.mode),
                        "timeOfSample": new Date().toISOString(),
                        "uncertaintyInMilliseconds": 0
                    });

        if (targetSetpoint) {
            properties.push({
                "namespace": "Alexa.ThermostatController",
                "name": "targetSetpoint",
                "value": {
                    "value": eventSource.temperatureSetting.setpoint,
                    "scale": "CELSIUS"
                },
                "timeOfSample": new Date().toISOString(),
                "uncertaintyInMilliseconds": 0
            });
        }

        if (upperSetpoint) {
            properties.push({
                "namespace": "Alexa.ThermostatController",
                "name": "upperSetpoint",
                "value": {
                    "value": upperSetpoint,
                    "scale": "CELSIUS"
                },
                "timeOfSample": new Date().toISOString(),
                "uncertaintyInMilliseconds": 0
            });
        }

        if (lowerSetpoint) {
            properties.push({
                "namespace": "Alexa.ThermostatController",
                "name": "lowerSetpoint",
                "value": {
                    "value": lowerSetpoint,
                    "scale": "CELSIUS"
                },
                "timeOfSample": new Date().toISOString(),
                "uncertaintyInMilliseconds": 0
            });
        }

//        properties.push(
//        {
//            "namespace": "Alexa.ThermostatController",
//            "name": "adaptiveRecoveryStatus",
//            "value": "INACTIVE",
//            "timeOfSample": new Date().toISOString(),
//            "uncertaintyInMilliseconds": 0
//        });

        properties.push(
        {
            "namespace": "Alexa.TemperatureSensor",
            "name": "temperature",
            "value": {
                "value": eventSource.temperature,
                "scale": getAlexaTemperatureUnit(eventSource.temperatureUnit)
            },
            "timeOfSample": new Date().toISOString(),
            "uncertaintyInMilliseconds": 0
        });

        return {
            context: {
                "properties": properties
            }
        };
    },

    async sendEvent(eventSource: ScryptedDevice & Thermometer & TemperatureSetting, eventDetails, eventData): Promise<Partial<Report>> {      
        
        if (eventDetails.eventInterface === ScryptedInterface.TemperatureSetting) {
            let { setpoint } = eventSource.temperatureSetting;

            let targetSetpoint, lowerSetpoint, upperSetpoint;
    
            if (setpoint) {
                if (typeof setpoint === 'number') {
                    targetSetpoint = setpoint;
                }
                else {
                    upperSetpoint = Math.max(setpoint[0], setpoint[1]);
                    lowerSetpoint = Math.min(setpoint[0], setpoint[1]);
                }
            }
    
            let properties = [];
    
            properties.push({
                "namespace": "Alexa.ThermostatController",
                "name": "thermostatMode",
                "value": getAlexaThermostatMode(eventSource.temperatureSetting.mode),
                "timeOfSample": new Date().toISOString(),
                "uncertaintyInMilliseconds": 0
            });
    
            if (targetSetpoint) {
                properties.push({
                    "namespace": "Alexa.ThermostatController",
                    "name": "targetSetpoint",
                    "value": {
                        "value": eventSource.temperatureSetting.setpoint,
                        "scale": "CELSIUS"
                    },
                    "timeOfSample": new Date().toISOString(),
                    "uncertaintyInMilliseconds": 0
                });
            }
    
            if (upperSetpoint) {
                properties.push({
                    "namespace": "Alexa.ThermostatController",
                    "name": "upperSetpoint",
                    "value": {
                        "value": upperSetpoint,
                        "scale": "CELSIUS"
                    },
                    "timeOfSample": new Date().toISOString(),
                    "uncertaintyInMilliseconds": 0
                });
            }
    
            if (lowerSetpoint) {
                properties.push({
                    "namespace": "Alexa.ThermostatController",
                    "name": "lowerSetpoint",
                    "value": {
                        "value": lowerSetpoint,
                        "scale": "CELSIUS"
                    },
                    "timeOfSample": new Date().toISOString(),
                    "uncertaintyInMilliseconds": 0
                });
            }
    
    //        properties.push(
    //        {
    //            "namespace": "Alexa.ThermostatController",
    //            "name": "adaptiveRecoveryStatus",
    //            "value": "INACTIVE",
    //            "timeOfSample": new Date().toISOString(),
    //            "uncertaintyInMilliseconds": 0
    //        });
    
            properties.push(
            {
                "namespace": "Alexa.TemperatureSensor",
                "name": "temperature",
                "value": {
                    "value": eventSource.temperature,
                    "scale": getAlexaTemperatureUnit(eventSource.temperatureUnit)
                },
                "timeOfSample": new Date().toISOString(),
                "uncertaintyInMilliseconds": 0
            });

            return {
                event: {
                    payload: {
                        change: {
                            cause: {
                                type: "RULE_TRIGGER"
                            },
                            properties: properties
                        }
                    } as ChangePayload,
                }
            } as Partial<ChangeReport>;
        }

        if (eventDetails.eventInterface === ScryptedInterface.Thermometer)
            return {
                event: {
                    payload: {
                        change: {
                            cause: {
                                type: "PERIODIC_POLL"
                            },
                            properties: [
                                {
                                    "namespace": "Alexa.TemperatureSensor",
                                    "name": "temperature",
                                    "value": {
                                        "value": eventSource.temperature,
                                        "scale": getAlexaTemperatureUnit(eventSource.temperatureUnit)
                                    },
                                    "timeOfSample": new Date(eventDetails.eventTime).toISOString(),
                                    "uncertaintyInMilliseconds": 0
                                } as Property
                            ]
                        }
                    } as ChangePayload,
                }
            } as Partial<ChangeReport>;
    }
});
