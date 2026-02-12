import type { CronService } from './service.js';

let defaultCronService: CronService | null = null;
const channelCronServices = new Map<string, CronService>();

export function setCronService(service: CronService | null): void;
export function setCronService(channel: string, service: CronService | null): void;
export function setCronService(
    serviceOrChannel: CronService | null | string,
    maybeService?: CronService | null
): void {
    if (typeof serviceOrChannel === 'string') {
        const channel = serviceOrChannel.trim().toLowerCase();
        if (!channel) return;
        const service = maybeService ?? null;
        if (service) {
            channelCronServices.set(channel, service);
            if (!defaultCronService) {
                defaultCronService = service;
            }
        } else {
            const existing = channelCronServices.get(channel);
            channelCronServices.delete(channel);
            if (existing && defaultCronService === existing) {
                defaultCronService = channelCronServices.values().next().value || null;
            }
        }
        return;
    }

    defaultCronService = serviceOrChannel;
}

export function getCronService(channel?: string): CronService | null {
    const normalized = channel?.trim().toLowerCase();
    if (normalized) {
        const service = channelCronServices.get(normalized);
        if (service) {
            return service;
        }
    }
    return defaultCronService;
}
