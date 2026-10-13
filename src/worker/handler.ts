/**
 * ワーカー Lambda（通常の Lambda）。
 * Step Functions 版が各 Task ステートから呼ぶ。durable 版は SDK の step 内から
 * 直接モック関数を呼ぶ（別 Lambda には出さない）が、「同じモックを呼ぶ」ために
 * ロジックは src/common/mocks.ts に集約してある。
 *
 * 1 つの関数で action を分岐する（Step Functions の Payload で action を渡す）。
 */
import type { FaultInjection } from "../common/domain.js";
import { partners, resources, sales, viewingPage } from "../common/mocks.js";

interface WorkerEvent {
  action:
    | "reserve_streaming"
    | "open_viewing_page"
    | "notify_partners"
    | "start_streaming"
    | "record_cancellation"
    | "close_viewing_page"
    | "abort_sales"
    | "compensate_notify_partners"
    | "release_streaming";
  eventId: string;
  /** Step Functions 版で見るのは failStep だけ（正常系 1〜3 の失敗を Catch の経路で確かめる）。補償まわりの故障注入は Durable Functions 版専用 */
  fault?: FaultInjection;
}

export const handler = async (event: WorkerEvent): Promise<unknown> => {
  const { action, eventId } = event;
  switch (action) {
    case "reserve_streaming":
      maybeFail(event, "reserve_streaming");
      await resources.reserve(eventId);
      return { ok: true };

    case "open_viewing_page":
      maybeFail(event, "open_viewing_page");
      await viewingPage.open(eventId);
      return { ok: true };

    case "notify_partners":
      maybeFail(event, "notify_partners");
      await partners.notifyStreamInfo(eventId);
      return { ok: true };

    case "start_streaming":
      await resources.start(eventId);
      return { ok: true };

    // ---- 補償 ----
    case "record_cancellation":
      await sales.stopAndShowCancelled(eventId);
      return { ok: true };
    case "close_viewing_page":
      await viewingPage.close(eventId);
      return { ok: true };
    case "abort_sales":
      await sales.stop(eventId);
      return { ok: true };
    case "compensate_notify_partners":
      await partners.notifyCancellation(eventId);
      return { ok: true };
    case "release_streaming":
      await resources.release(eventId);
      return { ok: true };

    default:
      throw new Error(`unknown action: ${action}`);
  }
};

function maybeFail(event: WorkerEvent, step: string): void {
  if (event.fault?.failStep === step) {
    throw new Error(`injected failure at step: ${step}`);
  }
}
