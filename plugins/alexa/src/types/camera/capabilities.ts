import sdk, { MediaObject, MotionSensor, ObjectDetector, ScryptedDevice, ScryptedInterface } from "@scrypted/sdk";
import { v4 as createMessageId } from 'uuid';
import { ChangeReport, DiscoveryCapability, ObjectDetectionEvent, Report, StateReport, Property } from "../../alexa";

const { mediaManager } = sdk;

const VALID_OBJECT_DETECTION_CLASSES = new Set<string>(['person', 'package']);
const DEFAULT_OBJECT_DETECTION_CLASSES = ['person', 'package'];

const enabledObjectDetectionClasses = new Map<string, Set<string>>();
let persistObjectDetectionClasses: ((value: Record<string, string[]>) => void) | undefined;

function normalizeObjectDetectionClasses(classes: Iterable<string> | undefined): Set<string> {
    const result = new Set<string>();
    if (!classes)
        return result;
    for (const cls of classes) {
        const imageNetClass = typeof cls === 'string' ? cls.toLowerCase() : undefined;
        if (imageNetClass && VALID_OBJECT_DETECTION_CLASSES.has(imageNetClass))
            result.add(imageNetClass);
    }
    return result;
}

export function setObjectDetectionClassesPersistence(saved: Record<string, string[]> | undefined, persist?: (value: Record<string, string[]>) => void) {
    persistObjectDetectionClasses = persist;
    enabledObjectDetectionClasses.clear();
    if (!saved || typeof saved !== 'object')
        return;
    for (const [deviceId, classes] of Object.entries(saved)) {
        if (!deviceId)
            continue;
        enabledObjectDetectionClasses.set(deviceId, normalizeObjectDetectionClasses(Array.isArray(classes) ? classes : []));
    }
}

export function getEnabledObjectDetectionClasses(deviceId: string): Set<string> {
    return enabledObjectDetectionClasses.get(deviceId) ?? new Set(DEFAULT_OBJECT_DETECTION_CLASSES);
}

export function setEnabledObjectDetectionClasses(deviceId: string, classes: string[]) {
    enabledObjectDetectionClasses.set(deviceId, normalizeObjectDetectionClasses(classes));
    if (!persistObjectDetectionClasses)
        return;
    const saved: Record<string, string[]> = {};
    for (const [id, enabled] of enabledObjectDetectionClasses)
        saved[id] = [...enabled];
    persistObjectDetectionClasses(saved);
}

export async function reportCameraState(device: ScryptedDevice & MotionSensor & ObjectDetector): Promise<Partial<Report>>{
    let data = {
        context: {
            properties: []
        }
        
    } as Partial<StateReport>;

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

export async function sendCameraEvent (eventSource: ScryptedDevice & MotionSensor & ObjectDetector, eventDetails, eventData): Promise<Partial<Report>> {      
    if (eventDetails.eventInterface === ScryptedInterface.ObjectDetector) {

        // ring and motion are not valid objects, but may accompany valid detections.
        // Only emit classes the customer enabled via SetObjectDetectionClasses (default: person, package).
        const enabled = getEnabledObjectDetectionClasses(eventSource.id);
        const detections = eventData.detections?.filter(detection => {
            const className = detection.className?.toLowerCase();
            if (!className || className === 'ring' || className === 'motion')
                return false;
            return enabled.has(className);
        });
        if (!detections?.length)
            return undefined;

        console.debug('ObjectDetector event', eventData);

        let mediaObj: MediaObject = undefined;
        let frameImageUri: string = undefined;

        try {
            mediaObj = await eventSource.getDetectionInput(eventData.detectionId, eventDetails.eventId);
            frameImageUri = await mediaManager.convertMediaObjectToUrl(mediaObj, 'image/jpeg');
        } catch (e) { }

        let data = {
            event: {
                header: {
                    namespace: 'Alexa.SmartVision.ObjectDetectionSensor',
                    name: 'ObjectDetection'
                },
                payload: {
                    "events": detections.map(detection => {
                        let event = {
                            "eventIdentifier": createMessageId(),
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
                    })
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

export async function getCameraCapabilities(device: ScryptedDevice): Promise<DiscoveryCapability[]> {
    // Only advertise full-duplex (two-way) audio when the camera can actually receive audio,
    // i.e. it implements the Intercom interface. Advertising full duplex on a one-way camera
    // makes Alexa set up a return mic path that goes nowhere, degrading the connect experience.
    // Half-duplex cameras send an 'a=sendonly' answer during negotiation.
    const isFullDuplexAudioSupported = device.interfaces.includes(ScryptedInterface.Intercom);

    const capabilities = [
        {
            "type": "AlexaInterface",
            "interface": "Alexa.RTCSessionController",
            "version": "3",
            "configuration": {
                isFullDuplexAudioSupported,
            }
        } as DiscoveryCapability
    ];

    if (device.interfaces.includes(ScryptedInterface.ObjectDetector)) {
        const detectionTypes = await (device as any as ObjectDetector).getObjectTypes().catch(() => {}) || undefined;
        const classNames = detectionTypes?.classes?.filter(t => t !== 'ring' && t !== 'motion').map(type => type.toLowerCase()).filter(c => !!c);
        if (classNames?.length) {
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
