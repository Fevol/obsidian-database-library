import { getNodesInText } from '../editor/editor-util';

self.onmessage = async (event) => {
	console.time('commentator: worker working')
	const file_contents: string[] = event.data;

	const parser = async (file: string) => {
		return getNodesInText(file).nodes;
	}

	const files = await Promise.all(file_contents.map(parser));
	console.timeEnd('commentator: worker working')

	self.postMessage(files);
}
