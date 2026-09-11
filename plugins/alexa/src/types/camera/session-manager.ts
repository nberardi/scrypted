import type { RTCSessionControl } from '@scrypted/sdk';
import { randomUUID } from 'crypto';

export const RTC_ANSWER_TIMEOUT_MS = 5_000;
export const RTC_SESSION_MAX_LIFETIME_MS = 10 * 60 * 1_000;

export interface RtcSessionRegistration {
    readonly endpointId: string;
    readonly sessionId: string;
}

interface ManagedRtcSession {
    registration: RtcSessionRegistration;
    control?: RTCSessionControl;
    timeout: ReturnType<typeof setTimeout>;
}

function getSessionKey(endpointId: string, sessionId: string) {
    return `${endpointId}\0${sessionId}`;
}

async function safeEndSession(control?: RTCSessionControl) {
    try {
        await control?.endSession();
    }
    catch {
    }
}

export function createAnswerGeneratedForSession(directive: any, sdp: string) {
    const { header, endpoint } = directive;

    return {
        event: {
            header: {
                ...header,
                name: 'AnswerGeneratedForSession',
                messageId: randomUUID(),
            },
            endpoint,
            payload: {
                answer: {
                    format: 'SDP',
                    value: sdp,
                },
            },
        },
    };
}

export class RtcSessionManager {
    private sessions = new Map<string, ManagedRtcSession>();
    private maxLifetimeMs: number;

    constructor(maxLifetimeMs = RTC_SESSION_MAX_LIFETIME_MS) {
        this.maxLifetimeMs = maxLifetimeMs;
    }

    begin(endpointId: string, sessionId: string): RtcSessionRegistration {
        const key = getSessionKey(endpointId, sessionId);
        const previous = this.sessions.get(key);
        const registration = { endpointId, sessionId };
        const timeout = setTimeout(() => {
            void this.endRegistration(registration);
        }, this.maxLifetimeMs);
        timeout.unref?.();

        this.sessions.set(key, {
            registration,
            timeout,
        });

        if (previous)
            void this.endManagedSession(previous);

        return registration;
    }

    async attach(registration: RtcSessionRegistration, control: RTCSessionControl): Promise<boolean> {
        const key = getSessionKey(registration.endpointId, registration.sessionId);
        const managed = this.sessions.get(key);

        if (managed?.registration !== registration) {
            await safeEndSession(control);
            return false;
        }

        managed.control = control;
        return true;
    }

    async end(endpointId: string, sessionId: string): Promise<void> {
        const key = getSessionKey(endpointId, sessionId);
        const managed = this.sessions.get(key);
        if (!managed)
            return;

        this.sessions.delete(key);
        await this.endManagedSession(managed);
    }

    async endRegistration(registration: RtcSessionRegistration): Promise<void> {
        const key = getSessionKey(registration.endpointId, registration.sessionId);
        const managed = this.sessions.get(key);
        if (managed?.registration !== registration)
            return;

        this.sessions.delete(key);
        await this.endManagedSession(managed);
    }

    async endAll(): Promise<void> {
        const sessions = [...this.sessions.values()];
        this.sessions.clear();
        await Promise.all(sessions.map(session => this.endManagedSession(session)));
    }

    has(endpointId: string, sessionId: string): boolean {
        return this.sessions.has(getSessionKey(endpointId, sessionId));
    }

    private async endManagedSession(managed: ManagedRtcSession) {
        clearTimeout(managed.timeout);
        await safeEndSession(managed.control);
    }
}
