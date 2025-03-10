'use strict';
import {
	CancellationToken,
	commands,
	ConfigurationChangeEvent,
	Disposable,
	Event,
	EventEmitter,
	MarkdownString,
	TreeDataProvider,
	TreeItem,
	TreeItemCollapsibleState,
	TreeView,
	TreeViewExpansionEvent,
	TreeViewVisibilityChangeEvent,
	window,
} from 'vscode';
import {
	BranchesViewConfig,
	CommitsViewConfig,
	configuration,
	ContributorsViewConfig,
	FileHistoryViewConfig,
	LineHistoryViewConfig,
	RemotesViewConfig,
	RepositoriesViewConfig,
	SearchAndCompareViewConfig,
	StashesViewConfig,
	TagsViewConfig,
	ViewsCommonConfig,
	viewsCommonConfigKeys,
	viewsConfigKeys,
	ViewsConfigKeys,
} from '../configuration';
import { Container } from '../container';
import { Logger } from '../logger';
import { debug, Functions, log, Promises } from '../system';
import { BranchesView } from './branchesView';
import { CommitsView } from './commitsView';
import { ContributorsView } from './contributorsView';
import { FileHistoryView } from './fileHistoryView';
import { LineHistoryView } from './lineHistoryView';
import { PageableViewNode, ViewNode } from './nodes';
import { RemotesView } from './remotesView';
import { RepositoriesView } from './repositoriesView';
import { SearchAndCompareView } from './searchAndCompareView';
import { StashesView } from './stashesView';
import { TagsView } from './tagsView';

export type View =
	| BranchesView
	| CommitsView
	| ContributorsView
	| FileHistoryView
	| LineHistoryView
	| RemotesView
	| RepositoriesView
	| SearchAndCompareView
	| StashesView
	| TagsView;
export type ViewsWithCommits =
	| BranchesView
	| CommitsView
	| ContributorsView
	| RemotesView
	| RepositoriesView
	| SearchAndCompareView
	| TagsView;
export type ViewsWithPullRequests =
	| BranchesView
	| CommitsView
	| ContributorsView
	| RemotesView
	| RepositoriesView
	| SearchAndCompareView;

export interface TreeViewNodeCollapsibleStateChangeEvent<T> extends TreeViewExpansionEvent<T> {
	state: TreeItemCollapsibleState;
}

export abstract class ViewBase<
	RootNode extends ViewNode<View>,
	ViewConfig extends
		| BranchesViewConfig
		| ContributorsViewConfig
		| FileHistoryViewConfig
		| CommitsViewConfig
		| LineHistoryViewConfig
		| RemotesViewConfig
		| RepositoriesViewConfig
		| SearchAndCompareViewConfig
		| StashesViewConfig
		| TagsViewConfig,
> implements TreeDataProvider<ViewNode>, Disposable
{
	protected _onDidChangeTreeData = new EventEmitter<ViewNode | undefined>();
	get onDidChangeTreeData(): Event<ViewNode | undefined> {
		return this._onDidChangeTreeData.event;
	}

	private _onDidChangeVisibility = new EventEmitter<TreeViewVisibilityChangeEvent>();
	get onDidChangeVisibility(): Event<TreeViewVisibilityChangeEvent> {
		return this._onDidChangeVisibility.event;
	}

	private _onDidChangeNodeCollapsibleState = new EventEmitter<TreeViewNodeCollapsibleStateChangeEvent<ViewNode>>();
	get onDidChangeNodeCollapsibleState(): Event<TreeViewNodeCollapsibleStateChangeEvent<ViewNode>> {
		return this._onDidChangeNodeCollapsibleState.event;
	}

	protected disposables: Disposable[] = [];
	protected root: RootNode | undefined;
	protected tree: TreeView<ViewNode> | undefined;

	private readonly _lastKnownLimits = new Map<string, number | undefined>();

	constructor(public readonly id: string, public readonly name: string, protected readonly container: Container) {
		this.disposables.push(container.onReady(this.onReady, this));

		if (Logger.isDebugging || this.container.config.debug) {
			function addDebuggingInfo(item: TreeItem, node: ViewNode, parent: ViewNode | undefined) {
				if (item.tooltip == null) {
					item.tooltip = new MarkdownString(
						item.label != null && typeof item.label !== 'string' ? item.label.label : item.label ?? '',
					);
				}

				if (typeof item.tooltip === 'string') {
					item.tooltip = `${item.tooltip}\n\n---\ncontext: ${item.contextValue}\nnode: ${node.toString()}${
						parent != null ? `\nparent: ${parent.toString()}` : ''
					}`;
				} else {
					item.tooltip.appendMarkdown(
						`\n\n---\n\ncontext: \`${item.contextValue}\`\\\nnode: \`${node.toString()}\`${
							parent != null ? `\\\nparent: \`${parent.toString()}\`` : ''
						}`,
					);
				}
			}

			const getTreeItemFn = this.getTreeItem;
			this.getTreeItem = async function (this: ViewBase<RootNode, ViewConfig>, node: ViewNode) {
				const item = await getTreeItemFn.apply(this, [node]);

				const parent = node.getParent();

				if (node.resolveTreeItem != null) {
					if (item.tooltip != null) {
						addDebuggingInfo(item, node, parent);
					}

					const resolveTreeItemFn = node.resolveTreeItem;
					node.resolveTreeItem = async function (this: ViewBase<RootNode, ViewConfig>, item: TreeItem) {
						const resolvedItem = await resolveTreeItemFn.apply(this, [item]);

						addDebuggingInfo(resolvedItem, node, parent);

						return resolvedItem;
					};
				} else {
					addDebuggingInfo(item, node, parent);
				}

				return item;
			};
		}

		this.disposables.push(...this.registerCommands());
	}

	dispose() {
		Disposable.from(...this.disposables).dispose();
	}

	private onReady() {
		this.initialize({ showCollapseAll: this.showCollapseAll });
		setImmediate(() => this.onConfigurationChanged());
	}

	protected get showCollapseAll(): boolean {
		return true;
	}

	protected filterConfigurationChanged(e: ConfigurationChangeEvent) {
		if (!configuration.changed(e, 'views')) return false;

		if (configuration.changed(e, `views.${this.configKey}` as const)) return true;
		for (const key of viewsCommonConfigKeys) {
			if (configuration.changed(e, `views.${key}` as const)) return true;
		}

		return false;
	}
	private _title: string | undefined;
	get title(): string | undefined {
		return this._title;
	}
	set title(value: string | undefined) {
		this._title = value;
		if (this.tree != null) {
			this.tree.title = value;
		}
	}

	private _description: string | undefined;
	get description(): string | undefined {
		return this._description;
	}
	set description(value: string | undefined) {
		this._description = value;
		if (this.tree != null) {
			this.tree.description = value;
		}
	}

	private _message: string | undefined;
	get message(): string | undefined {
		return this._message;
	}
	set message(value: string | undefined) {
		this._message = value;
		if (this.tree != null) {
			this.tree.message = value;
		}
	}

	getQualifiedCommand(command: string) {
		return `${this.id}.${command}`;
	}

	protected abstract getRoot(): RootNode;
	protected abstract registerCommands(): Disposable[];
	protected onConfigurationChanged(e?: ConfigurationChangeEvent): void {
		if (e != null && this.root != null) {
			void this.refresh(true);
		}
	}

	protected initialize(options: { showCollapseAll?: boolean } = {}) {
		this.tree = window.createTreeView<ViewNode<View>>(this.id, {
			...options,
			treeDataProvider: this,
		});
		this.disposables.push(
			configuration.onDidChange(e => {
				if (!this.filterConfigurationChanged(e)) return;

				this._config = undefined;
				this.onConfigurationChanged(e);
			}, this),
			this.tree,
			this.tree.onDidChangeVisibility(Functions.debounce(this.onVisibilityChanged, 250), this),
			this.tree.onDidCollapseElement(this.onElementCollapsed, this),
			this.tree.onDidExpandElement(this.onElementExpanded, this),
		);
		this._title = this.tree.title;
	}

	protected ensureRoot(force: boolean = false) {
		if (this.root == null || force) {
			this.root = this.getRoot();
		}

		return this.root;
	}

	getChildren(node?: ViewNode): ViewNode[] | Promise<ViewNode[]> {
		if (node != null) return node.getChildren();

		const root = this.ensureRoot();
		return root.getChildren();
	}

	getParent(node: ViewNode): ViewNode | undefined {
		return node.getParent();
	}

	getTreeItem(node: ViewNode): TreeItem | Promise<TreeItem> {
		return node.getTreeItem();
	}

	resolveTreeItem(item: TreeItem, node: ViewNode): TreeItem | Promise<TreeItem> {
		return node.resolveTreeItem(item);
	}

	protected onElementCollapsed(e: TreeViewExpansionEvent<ViewNode>) {
		this._onDidChangeNodeCollapsibleState.fire({ ...e, state: TreeItemCollapsibleState.Collapsed });
	}

	protected onElementExpanded(e: TreeViewExpansionEvent<ViewNode>) {
		this._onDidChangeNodeCollapsibleState.fire({ ...e, state: TreeItemCollapsibleState.Expanded });
	}

	protected onVisibilityChanged(e: TreeViewVisibilityChangeEvent) {
		this._onDidChangeVisibility.fire(e);
	}

	get selection(): ViewNode[] {
		if (this.tree == null || this.root == null) return [];

		return this.tree.selection;
	}

	get visible(): boolean {
		return this.tree != null ? this.tree.visible : false;
	}

	async findNode(
		id: string,
		options?: {
			allowPaging?: boolean;
			canTraverse?: (node: ViewNode) => boolean | Promise<boolean>;
			maxDepth?: number;
			token?: CancellationToken;
		},
	): Promise<ViewNode | undefined>;
	async findNode(
		predicate: (node: ViewNode) => boolean,
		options?: {
			allowPaging?: boolean;
			canTraverse?: (node: ViewNode) => boolean | Promise<boolean>;
			maxDepth?: number;
			token?: CancellationToken;
		},
	): Promise<ViewNode | undefined>;
	@log({
		args: {
			0: (predicate: string | ((node: ViewNode) => boolean)) =>
				typeof predicate === 'string' ? predicate : 'function',
			1: (opts: {
				allowPaging?: boolean;
				canTraverse?: (node: ViewNode) => boolean | Promise<boolean>;
				maxDepth?: number;
				token?: CancellationToken;
			}) => `options=${JSON.stringify({ ...opts, canTraverse: undefined, token: undefined })}`,
		},
	})
	async findNode(
		predicate: string | ((node: ViewNode) => boolean),
		{
			allowPaging = false,
			canTraverse,
			maxDepth = 2,
			token,
		}: {
			allowPaging?: boolean;
			canTraverse?: (node: ViewNode) => boolean | Promise<boolean>;
			maxDepth?: number;
			token?: CancellationToken;
		} = {},
	): Promise<ViewNode | undefined> {
		const cc = Logger.getCorrelationContext();

		async function find(this: ViewBase<RootNode, ViewConfig>) {
			try {
				const node = await this.findNodeCoreBFS(
					typeof predicate === 'string' ? n => n.id === predicate : predicate,
					this.ensureRoot(),
					allowPaging,
					canTraverse,
					maxDepth,
					token,
				);

				return node;
			} catch (ex) {
				Logger.error(ex, cc);
				return undefined;
			}
		}

		if (this.root != null) return find.call(this);

		// If we have no root (e.g. never been initialized) force it so the tree will load properly
		await this.show({ preserveFocus: true });
		// Since we have to show the view, let the callstack unwind before we try to find the node
		return new Promise<ViewNode | undefined>(resolve => setTimeout(() => resolve(find.call(this)), 0));
	}

	private async findNodeCoreBFS(
		predicate: (node: ViewNode) => boolean,
		root: ViewNode,
		allowPaging: boolean,
		canTraverse: ((node: ViewNode) => boolean | Promise<boolean>) | undefined,
		maxDepth: number,
		token: CancellationToken | undefined,
	): Promise<ViewNode | undefined> {
		const queue: (ViewNode | undefined)[] = [root, undefined];

		const defaultPageSize = this.container.config.advanced.maxListItems;

		let depth = 0;
		let node: ViewNode | undefined;
		let children: ViewNode[];
		let pagedChildren: ViewNode[];
		while (queue.length > 1) {
			if (token?.isCancellationRequested) return undefined;

			node = queue.shift();
			if (node == null) {
				depth++;

				queue.push(undefined);
				if (depth > maxDepth) break;

				continue;
			}

			if (predicate(node)) return node;
			if (canTraverse != null) {
				const traversable = canTraverse(node);
				if (Promises.is(traversable)) {
					if (!(await traversable)) continue;
				} else if (!traversable) {
					continue;
				}
			}

			children = await node.getChildren();
			if (children.length === 0) continue;

			while (node != null && !PageableViewNode.is(node)) {
				node = await node.getSplattedChild?.();
			}

			if (node != null && PageableViewNode.is(node)) {
				let child = children.find(predicate);
				if (child != null) return child;

				if (allowPaging && node.hasMore) {
					while (true) {
						if (token?.isCancellationRequested) return undefined;

						await this.loadMoreNodeChildren(node, defaultPageSize);

						pagedChildren = await Promises.cancellable(
							Promise.resolve(node.getChildren()),
							token ?? 60000,
							{
								onDidCancel: resolve => resolve([]),
							},
						);

						child = pagedChildren.find(predicate);
						if (child != null) return child;

						if (!node.hasMore) break;
					}
				}

				// Don't traverse into paged children
				continue;
			}

			queue.push(...children);
		}

		return undefined;
	}

	protected async ensureRevealNode(
		node: ViewNode,
		options?: {
			select?: boolean;
			focus?: boolean;
			expand?: boolean | number;
		},
	) {
		// Not sure why I need to reveal each parent, but without it the node won't be revealed
		const nodes: ViewNode[] = [];

		let parent: ViewNode | undefined = node;
		while (parent != null) {
			nodes.push(parent);
			parent = parent.getParent();
		}

		if (nodes.length > 1) {
			nodes.pop();
		}

		for (const n of nodes.reverse()) {
			try {
				await this.reveal(n, options);
			} catch {}
		}
	}

	@debug()
	async refresh(reset: boolean = false) {
		await this.root?.refresh?.(reset);

		this.triggerNodeChange();
	}

	@debug({
		args: { 0: (n: ViewNode) => n.toString() },
	})
	async refreshNode(node: ViewNode, reset: boolean = false, force: boolean = false) {
		const cancel = await node.refresh?.(reset);
		if (!force && cancel === true) return;

		this.triggerNodeChange(node);
	}

	@log({
		args: { 0: (n: ViewNode) => n.toString() },
	})
	async reveal(
		node: ViewNode,
		options?: {
			select?: boolean;
			focus?: boolean;
			expand?: boolean | number;
		},
	) {
		if (this.tree == null) return;

		try {
			await this.tree.reveal(node, options);
		} catch (ex) {
			Logger.error(ex);
		}
	}

	@log()
	async show(options?: { preserveFocus?: boolean }) {
		try {
			void (await commands.executeCommand(`${this.id}.focus`, options));
		} catch (ex) {
			Logger.error(ex);
		}
	}

	// @debug({ args: { 0: (n: ViewNode) => n.toString() }, singleLine: true })
	getNodeLastKnownLimit(node: PageableViewNode) {
		return this._lastKnownLimits.get(node.id);
	}

	@debug({
		args: {
			0: (n: ViewNode & PageableViewNode) => n.toString(),
			3: (n?: ViewNode) => (n == null ? '' : n.toString()),
		},
	})
	async loadMoreNodeChildren(
		node: ViewNode & PageableViewNode,
		limit: number | { until: any } | undefined,
		previousNode?: ViewNode,
	) {
		if (previousNode != null) {
			void (await this.reveal(previousNode, { select: true }));
		}

		await node.loadMore(limit);
		this._lastKnownLimits.set(node.id, node.limit);
	}

	@debug({ args: { 0: (n: ViewNode) => n.toString() }, singleLine: true })
	resetNodeLastKnownLimit(node: PageableViewNode) {
		this._lastKnownLimits.delete(node.id);
	}

	@debug({
		args: { 0: (n: ViewNode) => (n != null ? n.toString() : '') },
	})
	triggerNodeChange(node?: ViewNode) {
		// Since the root node won't actually refresh, force everything
		this._onDidChangeTreeData.fire(node != null && node !== this.root ? node : undefined);
	}

	protected abstract readonly configKey: ViewsConfigKeys;

	private _config: (ViewConfig & ViewsCommonConfig) | undefined;
	get config(): ViewConfig & ViewsCommonConfig {
		if (this._config == null) {
			const cfg = { ...this.container.config.views };
			for (const view of viewsConfigKeys) {
				delete cfg[view];
			}

			this._config = {
				...(cfg as ViewsCommonConfig),
				...(this.container.config.views[this.configKey] as ViewConfig),
			};
		}

		return this._config;
	}
}
