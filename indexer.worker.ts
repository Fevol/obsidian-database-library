// Modify this file to fit your use-case
import { getNodesInText } from '../editor/base';

self.onmessage = async (event) => {
	const files = await Promise.all(event.data.map(async (file: string) => {
		return getNodesInText(file).nodes;
	}));

	self.postMessage(files);
}
