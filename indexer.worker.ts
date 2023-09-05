import { getNodesInText } from '../editor/editor-util';

self.onmessage = async (event) => {
	const files = await Promise.all(event.data.map(async (file: string) => {
		return getNodesInText(file).nodes;
	}));

	self.postMessage(files);
}
