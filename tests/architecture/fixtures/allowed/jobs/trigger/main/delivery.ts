/** Allowed (Step 7E.4B.3): main-plane delivery tasks use the main runtime module and the outbox delivery service. */
import { deliveryRuntimes } from "../../main-runtime";
import { relayPass } from "../../../platform/outbox/delivery";
export const relay: unknown[] = [deliveryRuntimes, relayPass];
