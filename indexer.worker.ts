// Export a indexWorker function in @root/index-worker.ts in order to define the worker
import { indexWorker } from "index-worker";

self.onmessage = async (event) => {
	self.postMessage(await indexWorker(event.data));
}
