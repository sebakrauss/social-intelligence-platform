/** Violation (Step 7G-H5.5-P5-B): the diagnostic task file stays thin — never the opener composition or a provider directly. */
import { leaked } from "../../integration-read-content-validation";
import { runDiscoverAssets } from "../../connections";
import { createMetaReadPort } from "../../../integrations/providers/meta/read-port";
export const reached: unknown[] = [leaked, runDiscoverAssets, createMetaReadPort];
