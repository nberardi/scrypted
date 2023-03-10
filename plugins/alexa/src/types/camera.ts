import { MotionSensor, ObjectDetector, PanTiltZoom, ScryptedDevice, ScryptedDeviceType, ScryptedInterface } from "@scrypted/sdk";
import { DiscoveryEndpoint, Report } from "../alexa";
import { getCameraCapabilities, reportCameraState, sendCameraEvent } from "./camera/capabilities";
import { supportedTypes } from ".";

supportedTypes.set(ScryptedDeviceType.Camera, {
    async discover(device: ScryptedDevice & PanTiltZoom): Promise<Partial<DiscoveryEndpoint>> {
        if (!device.interfaces.includes(ScryptedInterface.RTCSignalingChannel))
            return;

        const capabilities = await getCameraCapabilities(device);

        return {
            displayCategories: ['CAMERA'],
            capabilities
        }
    },
    sendReport(device: ScryptedDevice & MotionSensor & ObjectDetector & PanTiltZoom): Promise<Partial<Report>>{
        return reportCameraState(device);
    },
    sendEvent(eventSource: ScryptedDevice & MotionSensor & ObjectDetector & PanTiltZoom, eventDetails, eventData): Promise<Partial<Report>> {
        return sendCameraEvent(eventSource, eventDetails, eventData);
    }
});
