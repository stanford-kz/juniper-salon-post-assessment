import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DeliveryInput, DeliveryReceipt } from './types';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { nextBusinessTime } from './business-hours';

type ProviderOptions = { beforePublish?: (input: DeliveryInput) => Promise<void> };

// The provider hook makes cancellation at the publication boundary testable with
// the same filesystem adapter used by the app. Production uses no hook.
export function createOfferSender(options: ProviderOptions = {}) {
  return async function sendOffer(input: DeliveryInput): Promise<DeliveryReceipt> {
    const context = Context.current();
    const checkCancellation = () => context.cancellationSignal.throwIfAborted();
    context.heartbeat({ stage: 'preparing', offerId: input.offerId });
    const heartbeatTimer = setInterval(() => context.heartbeat({ stage: 'sending', offerId: input.offerId }), 100);
    try {
      checkCancellation();
      if (input.candidate.optedOut) throw ApplicationFailure.nonRetryable('Client opted out; no text sent.', 'OptedOut');
      const directory = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), '.data'), 'outbox');
      await mkdir(directory, { recursive: true });
      const key = createHash('sha256').update(input.offerId).digest('hex');
      const filename = path.join(directory, `${key}.json`);
      try { return JSON.parse(await readFile(filename, 'utf8')).receipt as DeliveryReceipt; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const checkDeliveryWindow = () => {
        checkCancellation();
        const timestamp = Date.now();
        if (timestamp >= Date.parse(input.slot.startsAt)) throw ApplicationFailure.nonRetryable('Appointment start reached; no new text sent.', 'AppointmentStarted');
        if (!input.demoMode && nextBusinessTime(timestamp) > timestamp) throw ApplicationFailure.nonRetryable('Business hours ended; defer delivery.', 'OutsideBusinessHours');
      };
      checkDeliveryWindow();
      if (input.candidate.simulateFailure && input.deliveryAttempt === 1) throw new Error('Simulated SMS provider outage. The first staff retry restores delivery.');
      const sentTimestamp = Date.now();
      const sentAt = new Date(sentTimestamp).toISOString();
      const expiresAt = new Date(Math.min(sentTimestamp + input.offerWindowSeconds * 1000, Date.parse(input.slot.startsAt))).toISOString();
      const time = (date: string) => new Date(date).toLocaleString('en-US', { timeZone: 'America/Phoenix', dateStyle: 'medium', timeStyle: 'short' });
      const receipt: DeliveryReceipt = { id: input.offerId, sentAt, expiresAt, channel: 'simulated_sms', message: `Juniper Salon: ${input.slot.service} with ${input.slot.stylist}, ${time(input.slot.startsAt)} (Phoenix). Reserved for you until ${time(expiresAt)} (Phoenix). Accept or decline before expiry. Late replies cannot claim this opening.` };
      const temporary = path.join(directory, `${key}-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify({ workflowId: input.workflowId, offerId: input.offerId, candidateId: input.candidate.id, mobile: input.candidate.mobile, receipt }, null, 2), { flag: 'wx' });
      try {
        if (options.beforePublish) await Promise.race([options.beforePublish(input), context.cancelled]);
        // Publish only a fully-written record and check cancellation immediately
        // beforehand. Cancellation is also checked throughout any provider wait.
        context.heartbeat({ stage: 'before_publish', offerId: input.offerId });
        checkDeliveryWindow();
        await link(temporary, filename);
        return receipt;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return JSON.parse(await readFile(filename, 'utf8')).receipt as DeliveryReceipt;
      } finally { await unlink(temporary).catch(() => undefined); }
    } finally { clearInterval(heartbeatTimer); }
  };
}

// A durable local mock of an SMS provider. The provider key survives restarts;
// a real integration must enforce this same key at its own publication boundary.
export const sendOffer = createOfferSender();
