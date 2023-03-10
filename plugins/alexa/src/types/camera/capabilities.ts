import sdk, { MediaObject, MotionSensor, ObjectDetector, PanTiltZoom, PanTiltZoomCapabilities, ScryptedDevice, ScryptedInterface } from "@scrypted/sdk";
import { ChangeReport, DiscoveryCapability, ObjectDetectionEvent, Report, StateReport, Property, RangeControllerDiscoveryCapability } from "../../alexa";

const { mediaManager } = sdk;

export async function reportCameraState(device: ScryptedDevice & MotionSensor & ObjectDetector & PanTiltZoom): Promise<Partial<Report>>{
    let data = {
        context: {
            properties: []
        }
        
    } as Partial<StateReport>;

    if (device.interfaces.includes(ScryptedInterface.PanTiltZoom)) {
        console.debug('PanTiltZoom capabilities', device.ptzCapabilities);
    }
    
    if (device.interfaces.includes(ScryptedInterface.ObjectDetector)) {
        const detectionTypes = await (device as any as ObjectDetector).getObjectTypes();
        const classNames = detectionTypes.classes.filter(t => t !== 'ring' && t !== 'motion').map(type => type.toLowerCase());

        data.context.properties.push({
            "namespace": "Alexa.SmartVision.ObjectDetectionSensor",
            "name": "objectDetectionClasses",
            "value": classNames.map(type => ({
                "imageNetClass": type
            })),
            "timeOfSample": new Date().toISOString(),
            "uncertaintyInMilliseconds": 0
        });
    }

    if (device.interfaces.includes(ScryptedInterface.MotionSensor)) {
        data.context.properties.push({
            "namespace": "Alexa.MotionSensor",
            "name": "detectionState",
            "value": device.motionDetected ? "DETECTED" : "NOT_DETECTED",
            "timeOfSample": new Date().toISOString(),
            "uncertaintyInMilliseconds": 0
        });
    }

    return data;
};

export async function sendCameraEvent (eventSource: ScryptedDevice & MotionSensor & ObjectDetector & PanTiltZoom, eventDetails, eventData): Promise<Partial<Report>> {      

    if (eventDetails.eventInterface === ScryptedInterface.PanTiltZoom) {
        console.debug('PanTiltZoom event', eventDetails, eventData);
    }

    if (eventDetails.eventInterface === ScryptedInterface.ObjectDetector) {

        // ring and motion are not valid objects
        if (eventData.detections.has('ring') || eventData.detections.has('motion'))
            return undefined;

        console.debug('ObjectDetector event', eventData);

        let mediaObj: MediaObject = undefined;
        let frameImageUri: string = undefined;

        try {
            mediaObj = await eventSource.getDetectionInput(eventData.detectionId, eventData.eventId);
            frameImageUri = await mediaManager.convertMediaObjectToUrl(mediaObj, 'image/jpeg');
        } catch (e) { }

        let data = {
            event: {
                header: {
                    namespace: 'Alexa.SmartVision.ObjectDetectionSensor',
                    name: 'ObjectDetection'
                },
                payload: {
                    "events": [eventData.detections.map(detection => {
                        let event = {
                            "eventIdentifier": eventData.eventId,
                            "imageNetClass": detection.className,
                            "timeOfSample": new Date(eventData.timestamp).toISOString(),
                            "uncertaintyInMilliseconds": 500
                        };
                        
                        if (detection.id) {
                            event["objectIdentifier"] = detection.id;
                        }

                        if (frameImageUri) {
                            event["frameImageUri"] = frameImageUri;
                        }

                        return event;
                    })]
                }
            }
        } as Partial<ObjectDetectionEvent>;

        return data;
    }
    
    if (eventDetails.eventInterface === ScryptedInterface.MotionSensor)
        return {
            event: {
                payload: {
                    change: {
                        cause: {
                            type: "PHYSICAL_INTERACTION"
                        },
                        properties: [
                            {
                                "namespace": "Alexa.MotionSensor",
                                "name": "detectionState",
                                "value": eventData ? "DETECTED" : "NOT_DETECTED",
                                "timeOfSample": new Date(eventDetails.eventTime).toISOString(),
                                "uncertaintyInMilliseconds": 500
                            }
                        ]
                    }
                },
            }
        } as Partial<ChangeReport>;

    return undefined;
};

function addZoom(capabilities: PanTiltZoomCapabilities) : RangeControllerDiscoveryCapability {
    if (!capabilities.zoom) 
        throw new Error('Zoom not supported');

    let capability = {
        "type": "AlexaInterface",
        "interface": "Alexa.RangeController",
        "version": "3",
        "instance": "Camera.Zoom",
        "capabilityResources": {
            "friendlyNames": [{
                    "@type": "text",
                    "value": {
                        "text": "Camera Zoom",
                        "locale": "en-US"
                    }
                },
                {
                    "@type": "text",
                    "value": {
                        "text": "Zoom",
                        "locale": "en-US"
                    }
                }
            ]
        },
        "properties": {
            "supported": [{
                "name": "rangeValue"
            }],
            "retrievable": true,
            "proactivelyReported": true
        },
        "configuration": {
            "supportedRange": {
                "minimumValue": 0,
                "maximumValue": 100,
                "precision": 1
            },
            "unitOfMeasure": "Alexa.Unit.Percent",
            "presets": [{
                    "rangeValue": 100,
                    "presetResources": {
                        "friendlyNames": [
                            {
                              "@type": "asset",
                              "value": {
                                "assetId": "Alexa.Value.Maximum"
                              }
                            },
                            {
                              "@type": "asset",
                              "value": {
                                "assetId": "Alexa.Value.High"
                              }
                            },
                            {
                            "@type": "text",
                            "value": {
                                "text": "Far In",
                                "locale": "en-US"
                            }
                        }]
                    }
                },
                {
                    "rangeValue": 0,
                    "presetResources": {
                        "friendlyNames": [
                            {
                              "@type": "asset",
                              "value": {
                                "assetId": "Alexa.Value.Minimum"
                              }
                            },
                            {
                              "@type": "asset",
                              "value": {
                                "assetId": "Alexa.Value.Low"
                              }
                            },
                            {
                            "@type": "text",
                            "value": {
                                "text": "Far Back",
                                "locale": "en-US"
                            }
                        }]
                    }
                }
            ]
        }
    } as RangeControllerDiscoveryCapability;

    return capability;
}

function addTilt(capabilities: PanTiltZoomCapabilities) : RangeControllerDiscoveryCapability {
    if (!capabilities.tilt) 
        throw new Error('Tilt not supported');

    let capability = {
        "type": "AlexaInterface",
        "interface": "Alexa.RangeController",
        "version": "3",
        "instance": "Camera.Tilt",
        "capabilityResources": {
            "friendlyNames": [{
                    "@type": "text",
                    "value": {
                        "text": "Camera Tilt",
                        "locale": "en-US"
                    }
                },
                {
                    "@type": "text",
                    "value": {
                        "text": "Tilt",
                        "locale": "en-US"
                    }
                }
            ]
        },
        "properties": {
            "supported": [{
                "name": "rangeValue"
            }],
            "retrievable": true,
            "proactivelyReported": true
        },
        "configuration": {
            "supportedRange": {
                "minimumValue": -200,
                "maximumValue": 200,
                "precision": 1
            },
            "unitOfMeasure": "Alexa.Unit.Percent",
            "presets": [{
                    "rangeValue": -200,
                    "presetResources": {
                    "friendlyNames": [
                        {
                          "@type": "asset",
                          "value": {
                            "assetId": "Alexa.Value.Minimum"
                          }
                        },
                        {
                          "@type": "asset",
                          "value": {
                            "assetId": "Alexa.Value.Low"
                          }
                        },
                        {
                            "@type": "asset",
                            "value": {
                              "assetId": "Alexa.Gesture.SwipeDown"
                            }
                        },
                        {
                            "@type": "text",
                            "value": {
                                "text": "Far Down",
                                "locale": "en-US"
                            }
                        }]
                    }
                },
                {
                    "rangeValue": 0,
                    "presetResources": {
                        "friendlyNames": [
                            {
                              "@type": "asset",
                              "value": {
                                "assetId": "Alexa.Value.Medium"
                              }
                            },
                            {
                                "@type": "text",
                                "value": {
                                    "text": "Center",
                                    "locale": "en-US"
                            }
                        }]
                    }
                },
                {
                    "rangeValue": 200,
                    "presetResources": {
                        "friendlyNames": [
                            {
                              "@type": "asset",
                              "value": {
                                "assetId": "Alexa.Value.Maximum"
                              }
                            },
                            {
                              "@type": "asset",
                              "value": {
                                "assetId": "Alexa.Value.High"
                              }
                            },
                            {
                                "@type": "asset",
                                "value": {
                                  "assetId": "Alexa.Gesture.SwipeUp"
                                }
                            },
                            {
                                "@type": "text",
                                "value": {
                                    "text": "Far Up",
                                    "locale": "en-US"
                            }
                        }]
                    }
                }
            ]
        }
    } as RangeControllerDiscoveryCapability;

    return capability;
}

function addPan(capabilities: PanTiltZoomCapabilities) : RangeControllerDiscoveryCapability {
    if (!capabilities.pan) 
        throw new Error('Pan not supported');

    let capability = {
        "type": "AlexaInterface",
        "interface": "Alexa.RangeController",
        "version": "3",
        "instance": "Camera.Pan",
        "capabilityResources": {
            "friendlyNames": [{
                    "@type": "text",
                    "value": {
                        "text": "Camera Pan",
                        "locale": "en-US"
                    }
                },
                {
                    "@type": "text",
                    "value": {
                        "text": "Camera Rotation",
                        "locale": "en-US"
                    }
                },
                {
                    "@type": "text",
                    "value": {
                        "text": "Rotation",
                        "locale": "en-US"
                    }
                }
            ]
        },
        "properties": {
            "supported": [{
                "name": "rangeValue"
            }],
            "retrievable": true,
            "proactivelyReported": true
        },
        "configuration": {
            "supportedRange": {
                "minimumValue": -200,
                "maximumValue": 200,
                "precision": 0.1
            },
            "unitOfMeasure": "Alexa.Unit.Percent",
            "presets": [{
                "rangeValue": -200,
                "presetResources": {
                "friendlyNames": [
                    {
                      "@type": "asset",
                      "value": {
                        "assetId": "Alexa.Value.Minimum"
                      }
                    },
                    {
                      "@type": "asset",
                      "value": {
                        "assetId": "Alexa.Value.Low"
                      }
                    },
                    {
                        "@type": "asset",
                        "value": {
                          "assetId": "Alexa.Gesture.SwipeLeft"
                        }
                    },
                    {
                        "@type": "text",
                        "value": {
                            "text": "Far Left",
                            "locale": "en-US"
                        }
                    }]
                }
            },
            {
                "rangeValue": 0,
                "presetResources": {
                    "friendlyNames": [
                        {
                          "@type": "asset",
                          "value": {
                            "assetId": "Alexa.Value.Medium"
                          }
                        },
                        {
                            "@type": "text",
                            "value": {
                                "text": "Center",
                                "locale": "en-US"
                        }
                    }]
                }
            },
            {
                "rangeValue": 200,
                "presetResources": {
                    "friendlyNames": [
                        {
                          "@type": "asset",
                          "value": {
                            "assetId": "Alexa.Value.Maximum"
                          }
                        },
                        {
                          "@type": "asset",
                          "value": {
                            "assetId": "Alexa.Value.High"
                          }
                        },
                        {
                            "@type": "asset",
                            "value": {
                              "assetId": "Alexa.Gesture.SwipeRight"
                            }
                        },
                        {
                            "@type": "text",
                            "value": {
                                "text": "Far Right",
                                "locale": "en-US"
                        }
                    }]
                }
            }
        ]
        }
    } as RangeControllerDiscoveryCapability;

    return capability;
}

export async function getCameraCapabilities(device: ScryptedDevice & PanTiltZoom): Promise<DiscoveryCapability[]> {
    const capabilities = [
        {
            "type": "AlexaInterface",
            "interface": "Alexa.RTCSessionController",
            "version": "3",
            "configuration": {
                isFullDuplexAudioSupported: true,
            }
        } as DiscoveryCapability
    ];

    if (device.interfaces.includes(ScryptedInterface.ObjectDetector)) {
        const detectionTypes = await (device as any as ObjectDetector).getObjectTypes();
        const classNames = detectionTypes.classes.filter(t => t !== 'ring' && t !== 'motion').map(type => type.toLowerCase());

        capabilities.push(
            {
                "type": "AlexaInterface",
                "interface": "Alexa.SmartVision.ObjectDetectionSensor",
                "version": "1.0",
                "properties": {
                    "supported": [{
                        "name": "objectDetectionClasses"
                    }],
                    "proactivelyReported": true,
                    "retrievable": true
                },
                "configuration": {
                    "objectDetectionConfiguration": classNames.map(type => ({
                        "imageNetClass": type
                    }))
                }
            } as DiscoveryCapability
        );

        capabilities.push(
            {
                "type": "AlexaInterface",
                "interface": "Alexa.DataController",
                "instance": "Camera.SmartVisionData",
                "version": "1.0",
                "properties": undefined,
                "configuration": {
                    "targetCapability": {
                        "name": "Alexa.SmartVision.ObjectDetectionSensor",
                        "version": "1.0"
                    },
                    "dataRetrievalSchema": {
                        "type": "JSON",
                        "schema": "SmartVisionData"
                    },
                    "supportedAccess": ["BY_IDENTIFIER", "BY_TIMESTAMP_RANGE"]
                }
            } as DiscoveryCapability
        );
    }

    if (device.interfaces.includes(ScryptedInterface.PanTiltZoom)) {
        if (device.ptzCapabilities.pan)
            capabilities.push(addPan(device.ptzCapabilities));

        if (device.ptzCapabilities.tilt)
            capabilities.push(addTilt(device.ptzCapabilities));

        if (device.ptzCapabilities.zoom)
            capabilities.push(addZoom(device.ptzCapabilities));
    }

    if (device.interfaces.includes(ScryptedInterface.MotionSensor)) {
        capabilities.push(
            {
                "type": "AlexaInterface",
                "interface": "Alexa.MotionSensor",
                "version": "3",
                "properties": {
                    "supported": [
                        {
                            "name": "detectionState"
                        }
                    ],
                    "proactivelyReported": true,
                    "retrievable": true
                }
            } as DiscoveryCapability
        );
    }

    return capabilities;
};