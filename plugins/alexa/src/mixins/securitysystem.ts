import sdk, { BinarySensor, DeviceState, EventDetails, EventListenerRegister, FloodSensor, MixinProvider, Notifier, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, SecuritySystem, Setting, SettingValue, Settings } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "./settings-mixin";

const { deviceManager, systemManager } = sdk;

export class AlexaSecuritySystemMixin extends SettingsMixinDeviceBase<SecuritySystem & Settings> implements Settings, FloodSensor {
    readDevice = systemManager.getDeviceById<SecuritySystem>(this.id);

    storageSettings = new StorageSettings(this, {
        floodDevices: {
            title: "Flood Devices",
            description: "Devices that will trigger the flood water alarm in Alexa",
            type: "device",
            multiple: true,
            deviceFilter: `interfaces.includes('${ScryptedInterface.FloodSensor}')`,
            onPut: (oldValue, newValue) => {
                this.setup();
            }
        }
    });

    listeners: Array<EventListenerRegister>;

    constructor(options: SettingsMixinDeviceOptions<SecuritySystem & Settings>) {
        super(options);
        this.listeners = [];

        this.setup();
    }

    getMixinSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    putMixinSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }
    
    setup() {
        this.removeListeners();

        let floodDeviceIds: string[] = this.storageSettings.values.floodDevices;

        for (const deviceId of floodDeviceIds) {
            const device = systemManager.getDeviceById(deviceId);

            if (!device)
                continue;

            if (device.interfaces.includes(ScryptedInterface.FloodSensor)) {
                this.listeners.push(device.listen({ event: ScryptedInterface.FloodSensor, watch: true }, (eventSource: ScryptedDevice | undefined, eventDetails: EventDetails, eventData: any) => {
                    if (!!eventData) {
                        this.console.log(`[${new Date()}] Flood Alarm triggered by ${eventDetails.eventInterface}=${eventData} on '${eventSource?.name}'`)
                        this.triggerFlood(eventSource, eventDetails, eventData);
                      } else {
                        this.console.log(`[${new Date()}] Flood Alarm detected ${eventDetails.eventInterface}=${eventData} on '${eventSource?.name}'`)
                      }
                }));
            }
        }
    }

    triggerFlood(eventSource: ScryptedDevice | undefined, eventDetails: EventDetails, eventData: any) {
        this.flooded = eventData;
    }

    removeListeners() {
        this.listeners.forEach((listener) => {
          listener.removeListener();
        })
        this.listeners = [];
    }
}