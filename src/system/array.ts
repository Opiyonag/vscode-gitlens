'use strict';

export { findLastIndex, intersectionWith as intersection } from 'lodash-es';

export function chunk<T>(source: T[], size: number): T[][] {
	const chunks = [];

	let index = 0;
	while (index < source.length) {
		chunks.push(source.slice(index, size + index));
		index += size;
	}
	return chunks;
}

export function countStringLength(source: string[]): number {
	let length = 0;
	for (const s of source) {
		length += s.length;
	}
	return length;
}

export function countUniques<T>(source: T[], accessor: (item: T) => string): Record<string, number> {
	const uniqueCounts = Object.create(null) as Record<string, number>;
	for (const item of source) {
		const value = accessor(item);
		uniqueCounts[value] = (uniqueCounts[value] ?? 0) + 1;
	}
	return uniqueCounts;
}

export function ensure<T>(source: T | T[] | undefined): T[] | undefined {
	return source == null ? undefined : Array.isArray(source) ? source : [source];
}

export function filterMap<T, TMapped>(
	source: T[],
	predicateMapper: (item: T, index: number) => TMapped | null | undefined,
): TMapped[] {
	let index = 0;
	return source.reduce((accumulator, current) => {
		const mapped = predicateMapper(current, index++);
		if (mapped != null) {
			accumulator.push(mapped);
		}
		return accumulator;
	}, [] as TMapped[]);
}

export function filterMapAsync<T, TMapped>(
	source: T[],
	predicateMapper: (item: T, index: number) => Promise<TMapped | null | undefined>,
): Promise<TMapped[]> {
	let index = 0;
	return source.reduce(async (accumulator, current) => {
		const mapped = await predicateMapper(current, index++);
		if (mapped != null) {
			accumulator.push(mapped);
		}
		return accumulator;
	}, [] as any);
}

export function groupBy<T>(source: T[], groupingKey: (item: T) => string): Record<string, T[]> {
	return source.reduce((groupings, current) => {
		const value = groupingKey(current);
		const group = groupings[value];
		if (group === undefined) {
			groupings[value] = [current];
		} else {
			group.push(current);
		}
		return groupings;
	}, Object.create(null) as Record<string, T[]>);
}

export function groupByMap<TKey, TValue>(source: TValue[], groupingKey: (item: TValue) => TKey): Map<TKey, TValue[]> {
	return source.reduce((groupings, current) => {
		const value = groupingKey(current);
		const group = groupings.get(value);
		if (group === undefined) {
			groupings.set(value, [current]);
		} else {
			group.push(current);
		}
		return groupings;
	}, new Map<TKey, TValue[]>());
}

export function groupByFilterMap<TKey, TValue, TMapped>(
	source: TValue[],
	groupingKey: (item: TValue) => TKey,
	predicateMapper: (item: TValue) => TMapped | null | undefined,
): Map<TKey, TMapped[]> {
	return source.reduce((groupings, current) => {
		const mapped = predicateMapper(current);
		if (mapped != null) {
			const value = groupingKey(current);
			const group = groupings.get(value);
			if (group === undefined) {
				groupings.set(value, [mapped]);
			} else {
				group.push(mapped);
			}
		}
		return groupings;
	}, new Map<TKey, TMapped[]>());
}

export function isStringArray<T extends any[]>(array: string[] | T): array is string[] {
	return typeof array[0] === 'string';
}

export interface HierarchicalItem<T> {
	name: string;
	relativePath: string;
	value?: T;

	parent?: HierarchicalItem<T>;
	children: Map<string, HierarchicalItem<T>> | undefined;
	descendants: T[] | undefined;
}

export function makeHierarchical<T>(
	values: T[],
	splitPath: (i: T) => string[],
	joinPath: (...paths: string[]) => string,
	compact: boolean = false,
	canCompact?: (i: T) => boolean,
): HierarchicalItem<T> {
	const seed = {
		name: '',
		relativePath: '',
		children: new Map(),
		descendants: [],
	};

	let hierarchy = values.reduce((root: HierarchicalItem<T>, value) => {
		let folder = root;

		let relativePath = '';
		for (const folderName of splitPath(value)) {
			relativePath = joinPath(relativePath, folderName);

			if (folder.children === undefined) {
				folder.children = new Map();
			}

			let f = folder.children.get(folderName);
			if (f === undefined) {
				f = {
					name: folderName,
					relativePath: relativePath,
					parent: folder,
					children: undefined,
					descendants: undefined,
				};
				folder.children.set(folderName, f);
			}

			if (folder.descendants === undefined) {
				folder.descendants = [];
			}
			folder.descendants.push(value);
			folder = f;
		}

		folder.value = value;

		return root;
	}, seed);

	if (compact) {
		hierarchy = compactHierarchy(hierarchy, joinPath, true, canCompact);
	}

	return hierarchy;
}

export function compactHierarchy<T>(
	root: HierarchicalItem<T>,
	joinPath: (...paths: string[]) => string,
	isRoot: boolean = true,
	canCompact?: (i: T) => boolean,
): HierarchicalItem<T> {
	if (root.children === undefined) return root;

	const children = [...root.children.values()];
	for (const child of children) {
		compactHierarchy(child, joinPath, false, canCompact);
	}

	if (!isRoot && children.length === 1) {
		const child = children[0];
		if (child.value === undefined || canCompact?.(child.value)) {
			root.name = joinPath(root.name, child.name);
			root.relativePath = child.relativePath;
			root.children = child.children;
			root.descendants = child.descendants;
			root.value = child.value;
		}
	}

	return root;
}

export function uniqueBy<TKey, TValue>(
	source: TValue[],
	uniqueKey: (item: TValue) => TKey,
	onDeduplicate: (original: TValue, current: TValue) => TValue | void,
) {
	const map = source.reduce((uniques, current) => {
		const value = uniqueKey(current);
		const original = uniques.get(value);
		if (original === undefined) {
			uniques.set(value, current);
		} else {
			const updated = onDeduplicate(original, current);
			if (updated !== undefined) {
				uniques.set(value, updated);
			}
		}
		return uniques;
	}, new Map<TKey, TValue>());
	return [...map.values()];
}
