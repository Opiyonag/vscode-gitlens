'use strict';
import * as paths from 'path';
import { Disposable, TreeItem, TreeItemCollapsibleState, window } from 'vscode';
import { configuration } from '../../configuration';
import { Container } from '../../container';
import {
	GitBranch,
	GitLog,
	GitRevision,
	RepositoryChange,
	RepositoryChangeComparisonMode,
	RepositoryChangeEvent,
	RepositoryFileSystemChangeEvent,
	toFolderGlob,
} from '../../git/git';
import { GitUri } from '../../git/gitUri';
import { Logger } from '../../logger';
import { Arrays, debug, gate, Iterables, memoize } from '../../system';
import { FileHistoryView } from '../fileHistoryView';
import { CommitNode } from './commitNode';
import { LoadMoreNode, MessageNode } from './common';
import { FileHistoryTrackerNode } from './fileHistoryTrackerNode';
import { FileRevisionAsCommitNode } from './fileRevisionAsCommitNode';
import { insertDateMarkers } from './helpers';
import { RepositoryNode } from './repositoryNode';
import { ContextValues, PageableViewNode, SubscribeableViewNode, ViewNode } from './viewNode';

export class FileHistoryNode extends SubscribeableViewNode<FileHistoryView> implements PageableViewNode {
	static key = ':history:file';
	static getId(repoPath: string, uri: string): string {
		return `${RepositoryNode.getId(repoPath)}${this.key}(${uri})`;
	}

	protected override splatted = true;

	constructor(
		uri: GitUri,
		view: FileHistoryView,
		parent: ViewNode,
		private readonly folder: boolean,
		private readonly branch: GitBranch | undefined,
	) {
		super(uri, view, parent);
	}

	override toClipboard(): string {
		return this.uri.fileName;
	}

	override get id(): string {
		return FileHistoryNode.getId(this.uri.repoPath!, this.uri.toString(true));
	}

	async getChildren(): Promise<ViewNode[]> {
		this.view.description = `${this.label}${
			this.parent instanceof FileHistoryTrackerNode && !this.parent.followingEditor ? ' (pinned)' : ''
		}`;

		const children: ViewNode[] = [];

		const range = this.branch != null ? await Container.instance.git.getBranchAheadRange(this.branch) : undefined;
		const [log, fileStatuses, currentUser, getBranchAndTagTips, unpublishedCommits] = await Promise.all([
			this.getLog(),
			this.uri.sha == null
				? Container.instance.git.getStatusForFiles(this.uri.repoPath!, this.getPathOrGlob())
				: undefined,
			this.uri.sha == null ? Container.instance.git.getCurrentUser(this.uri.repoPath!) : undefined,
			this.branch != null
				? Container.instance.git.getBranchesAndTagsTipsFn(this.uri.repoPath, this.branch.name)
				: undefined,
			range
				? Container.instance.git.getLogRefsOnly(this.uri.repoPath!, {
						limit: 0,
						ref: range,
				  })
				: undefined,
		]);

		if (fileStatuses?.length) {
			if (this.folder) {
				const commits = Arrays.uniqueBy(
					[...Iterables.flatMap(fileStatuses, f => f.toPsuedoCommits(currentUser))],
					c => c.sha,
					(original, c) => void original.files.push(...c.files),
				);
				if (commits.length) {
					children.push(...commits.map(commit => new CommitNode(this.view, this, commit)));
				}
			} else {
				const [file] = fileStatuses;
				const commits = file.toPsuedoCommits(currentUser);
				if (commits.length) {
					children.push(
						...commits.map(commit => new FileRevisionAsCommitNode(this.view, this, file, commit)),
					);
				}
			}
		}

		if (log != null) {
			children.push(
				...insertDateMarkers(
					Iterables.map(log.commits.values(), c =>
						this.folder
							? new CommitNode(
									this.view as any,
									this,
									c,
									unpublishedCommits?.has(c.ref),
									this.branch,
									undefined,
									{
										expand: false,
									},
							  )
							: new FileRevisionAsCommitNode(this.view, this, c.files[0], c, {
									branch: this.branch,
									getBranchAndTagTips: getBranchAndTagTips,
									unpublished: unpublishedCommits?.has(c.ref),
							  }),
					),
					this,
				),
			);

			if (log.hasMore) {
				children.push(new LoadMoreNode(this.view, this, children[children.length - 1]));
			}
		}

		if (children.length === 0) return [new MessageNode(this.view, this, 'No file history could be found.')];
		return children;
	}

	getTreeItem(): TreeItem {
		this.splatted = false;

		const label = this.label;
		const item = new TreeItem(label, TreeItemCollapsibleState.Expanded);
		item.contextValue = ContextValues.FileHistory;
		item.description = this.uri.directory;
		item.tooltip = `History of ${this.uri.fileName}\n${this.uri.directory}/${
			this.uri.sha == null ? '' : `\n\n${this.uri.sha}`
		}`;

		this.view.description = `${label}${
			this.parent instanceof FileHistoryTrackerNode && !this.parent.followingEditor ? ' (pinned)' : ''
		}`;

		return item;
	}

	get label() {
		// Check if this is a base folder
		if (this.folder && this.uri.fileName === '') {
			return `${paths.basename(this.uri.fsPath)}${
				this.uri.sha
					? ` ${this.uri.sha === GitRevision.deletedOrMissing ? this.uri.shortSha : `(${this.uri.shortSha})`}`
					: ''
			}`;
		}

		return `${this.uri.fileName}${
			this.uri.sha
				? ` ${this.uri.sha === GitRevision.deletedOrMissing ? this.uri.shortSha : `(${this.uri.shortSha})`}`
				: ''
		}`;
	}

	@debug()
	protected async subscribe() {
		const repo = await Container.instance.git.getRepository(this.uri);
		if (repo == null) return undefined;

		const subscription = Disposable.from(
			repo.onDidChange(this.onRepositoryChanged, this),
			repo.onDidChangeFileSystem(this.onFileSystemChanged, this),
			repo.startWatchingFileSystem(),
			configuration.onDidChange(e => {
				if (configuration.changed(e, 'advanced.fileHistoryFollowsRenames')) {
					this.view.resetNodeLastKnownLimit(this);
				}
			}),
		);

		return subscription;
	}

	protected override get requiresResetOnVisible(): boolean {
		return true;
	}

	private onRepositoryChanged(e: RepositoryChangeEvent) {
		if (
			!e.changed(
				RepositoryChange.Index,
				RepositoryChange.Heads,
				RepositoryChange.Remotes,
				RepositoryChange.RemoteProviders,
				RepositoryChange.Status,
				RepositoryChange.Unknown,
				RepositoryChangeComparisonMode.Any,
			)
		) {
			return;
		}

		Logger.debug(`FileHistoryNode.onRepositoryChanged(${e.toString()}); triggering node refresh`);

		void this.triggerChange(true);
	}

	private onFileSystemChanged(e: RepositoryFileSystemChangeEvent) {
		if (this.folder) {
			if (!e.uris.some(uri => uri.fsPath.startsWith(this.uri.fsPath))) return;
		} else if (!e.uris.some(uri => uri.toString() === this.uri.toString())) {
			return;
		}

		Logger.debug(`FileHistoryNode.onFileSystemChanged(${this.uri.toString(true)}); triggering node refresh`);

		void this.triggerChange(true);
	}

	@gate()
	@debug()
	override refresh(reset?: boolean) {
		if (reset) {
			this._log = undefined;
		}
	}

	private _log: GitLog | undefined;
	private async getLog() {
		if (this._log == null) {
			this._log = await Container.instance.git.getLogForFile(this.uri.repoPath, this.getPathOrGlob(), {
				limit: this.limit ?? this.view.config.pageItemLimit,
				ref: this.uri.sha,
			});
		}

		return this._log;
	}

	@memoize()
	private getPathOrGlob() {
		return this.folder ? toFolderGlob(this.uri.fsPath) : this.uri.fsPath;
	}

	get hasMore() {
		return this._log?.hasMore ?? true;
	}

	limit: number | undefined = this.view.getNodeLastKnownLimit(this);
	@gate()
	async loadMore(limit?: number | { until?: any }) {
		let log = await window.withProgress(
			{
				location: { viewId: this.view.id },
			},
			() => this.getLog(),
		);
		if (log == null || !log.hasMore) return;

		log = await log.more?.(limit ?? this.view.config.pageItemLimit);
		if (this._log === log) return;

		this._log = log;
		this.limit = log?.count;

		// Needs to force if splatted, since the parent node will cancel the refresh (since it thinks nothing changed)
		void this.triggerChange(false, this.splatted);
	}
}
