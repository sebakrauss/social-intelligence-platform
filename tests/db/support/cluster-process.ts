/**
 * Child process that owns the disposable local cluster for `npm run test:db`. It writes one JSON line with
 * the target (in-memory credentials, read only by the parent through a pipe — never printed), then keeps
 * the cluster alive until its stdin closes, when it stops the cluster and deletes its directory. If the
 * parent dies, stdin closes and the cluster is cleaned up as well.
 */
import { startLocalCluster } from "./local-cluster.ts";

try {
  const cluster = await startLocalCluster();
  process.stdout.write(`${JSON.stringify({ target: cluster.target })}\n`);
  process.stdin.on("end", () => {
    void cluster.stop().finally(() => process.exit(0));
  });
  process.stdin.resume();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : "cluster failed to start" })}\n`);
  process.exit(1);
}
