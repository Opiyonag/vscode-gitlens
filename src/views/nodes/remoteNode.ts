'use strict';
import { ThemeIcon, TreeItem, TreeItemCollapsibleState, Uri } from 'vscode';
import { ViewBranchesLayout } from '../../configuration';
import { GlyphChars } from '../../constants';
import { Container } from '../../container';
import { GitRemote, GitRemoteType, Repository } from '../../git/git';
import { GitUri } from '../../git/gitUri';
import { Arrays, log } from '../../system';
import { RemotesView } from '../remotesView';
import { RepositoriesView } from '../repositoriesView';
import { BranchNode } from './branchNode';
import { BranchOrTagFolderNode } from './branchOrTagFolderNode';
import { MessageNode } from './common';
import { RepositoryNode } from './repositoryNode';
import { ContextValues, ViewNode } from './viewNode';

export class RemoteNode extends ViewNode<RemotesView | RepositoriesView> {
	static key = ':remote';
	static getId(repoPath: string, name: string, id: string): string {
		return `${RepositoryNode.getId(repoPath)}${this.key}(${name}|${id})`;
	}

	constructor(
		uri: GitUri,
		view: RemotesView | RepositoriesView,
		parent: ViewNode,
		public readonly remote: GitRemote,
		public readonly repo: Repository,
	) {
		super(uri, view, parent);
	}

	override toClipboard(): string {
		return this.remote.name;
	}

	override get id(): string {
		return RemoteNode.getId(this.remote.repoPath, this.remote.name, this.remote.id);
	}

	async getChildren(): Promise<ViewNode[]> {
		const branches = await this.repo.getBranches({
			// only show remote branches for this remote
			filter: b => b.remote && b.name.startsWith(this.remote.name),
			sort: true,
		});
		if (branches.length === 0) return [new MessageNode(this.view, this, 'No branches could be found.')];

		const branchNodes = branches.map(
			b =>
				new BranchNode(GitUri.fromRepoPath(this.uri.repoPath!, b.ref), this.view, this, b, false, {
					showComparison: false,
					showTracking: false,
				}),
		);
		if (this.view.config.branches.layout === ViewBranchesLayout.List) return branchNodes;

		const hierarchy = Arrays.makeHierarchical(
			branchNodes,
			n => n.treeHierarchy,
			(...paths) => paths.join('/'),
			this.view.config.files.compact,
			b => {
				b.compacted = true;
				return true;
			},
		);

		const root = new BranchOrTagFolderNode(
			this.view,
			this,
			'remote-branch',
			this.repo.path,
			'',
			undefined,
			hierarchy,
			`remote(${this.remote.name})`,
		);
		const children = root.getChildren();
		return children;
	}

	async getTreeItem(): Promise<TreeItem> {
		let arrows;
		let left;
		let right;
		for (const { type } of this.remote.urls) {
			if (type === GitRemoteType.Fetch) {
				left = true;

				if (right) break;
			} else if (type === GitRemoteType.Push) {
				right = true;

				if (left) break;
			}
		}

		if (left && right) {
			arrows = GlyphChars.ArrowsRightLeft;
		} else if (right) {
			arrows = GlyphChars.ArrowRight;
		} else if (left) {
			arrows = GlyphChars.ArrowLeft;
		} else {
			arrows = GlyphChars.Dash;
		}

		const item = new TreeItem(this.remote.name, TreeItemCollapsibleState.Collapsed);
		item.id = this.id;

		if (this.remote.provider != null) {
			const { provider } = this.remote;

			item.description = `${arrows}${GlyphChars.Space} ${provider.name} ${GlyphChars.Space}${GlyphChars.Dot}${GlyphChars.Space} ${provider.displayPath}`;
			item.iconPath =
				provider.icon === 'remote'
					? new ThemeIcon('cloud')
					: {
							dark: Container.instance.context.asAbsolutePath(`images/dark/icon-${provider.icon}.svg`),
							light: Container.instance.context.asAbsolutePath(`images/light/icon-${provider.icon}.svg`),
					  };

			if (provider.hasApi()) {
				const connected = provider.maybeConnected ?? (await provider.isConnected());

				item.contextValue = `${ContextValues.Remote}${connected ? '+connected' : '+disconnected'}`;
				item.tooltip = `${this.remote.name} (${provider.name} ${GlyphChars.Dash} ${
					connected ? 'connected' : 'not connected'
				})\n${provider.displayPath}\n`;
			} else {
				item.contextValue = ContextValues.Remote;
				item.tooltip = `${this.remote.name} (${provider.name})\n${provider.displayPath}\n`;
			}
		} else {
			item.description = `${arrows}${GlyphChars.Space} ${
				this.remote.domain
					? `${this.remote.domain} ${GlyphChars.Space}${GlyphChars.Dot}${GlyphChars.Space} `
					: ''
			}${this.remote.path}`;
			item.contextValue = ContextValues.Remote;
			item.iconPath = new ThemeIcon('cloud');
			item.tooltip = `${this.remote.name} (${this.remote.domain})\n${this.remote.path}\n`;
		}

		if (this.remote.default) {
			item.contextValue += '+default';
			item.resourceUri = Uri.parse('gitlens-view://remote/default');
		}

		for (const { type, url } of this.remote.urls) {
			item.tooltip += `\n${url} (${type})`;
		}

		return item;
	}

	@log()
	async setAsDefault(state: boolean = true) {
		void (await this.remote.setAsDefault(state));
		void this.triggerChange();
	}
}
