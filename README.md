A tiny library for creating persistent databases that stay in sync with the Obsidian vault, specifically written for use within [Obsidian](https://obsidian.md/) plugins.

The database is stored within IndexedDB and every database instance is unique for each vault on the device. Any JSON-serializable value can be stored within the database.

> [!IMPORTANT]
> This is not a plugin, but a library for plugin developers. It is not intended to be used by end-users.

## Setup

You can copy the source code into your plugin or fork this repository and use it as a submodule.

Required dependencies:

- `"esbuild-plugin-inline-worker": "https://github.com/mitschabaude/esbuild-plugin-inline-worker"` (Bundling the worker code into esbuild bundle)
- `"localforage": "^1.10.0"` (IndexedDB wrapper)
- `"localforage-getitems": "https://github.com/conversejs/localForage-getItems/tree/master"` (Custom fork of localforage-getItems that is slightly faster at loading all items from IndexedDB)
- `"localforage-setitems": "^1.4.0"` (Efficiently set multiple items in IndexedDB)

## Example usage

```ts
import { Database } from "database";

// Database can store any JSON-serializable value
type YOUR_TYPE = {
	some: number;
	data: string;
};

const database: Database<YOUR_TYPE> = new Database(
	this, /* Reference to the plugin */
	"database/name",
	"Pretty Database Name",
	1, /* Database version number */
	"A description of the database",
	// Default initialization of a value within the database
	() => [],
	// Extract the values you need from the file
	async (file: TFile) => {
		return YOUR_TYPE;
	},
	// Amount of worker threads to use when indexing the vault
	2,
	// Optional: alter data that is loaded from the database
	(data: YOUR_TYPE) => {
		return data;
	},
);

database.on("database-update", (data: DatabaseEntry<YOUR_TYPE>[]) => {
	// Do something with the data - update a view, apply some functions, ...
});
```

> [!NOTE]
> You will have to modify the `indexer.worker.ts` file for your own use-case. Keep in mind that you cannot pass the `app`/`vault`/... instance to the worker
