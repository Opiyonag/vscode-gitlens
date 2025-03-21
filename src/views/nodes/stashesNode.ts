'use strict';
import { TreeItem, TreeItemCollapsibleState } from 'vscode';
import { Container } from '../../container';
import { Repository } from '../../git/git';
import { GitUri } from '../../git/gitUri';
import { debug, gate, Iterables } from '../../system';
import { RepositoriesView } from '../repositoriesView';
import { StashesView } from '../stashesView';
import { MessageNode } from './common';
import { RepositoryNode } from './repositoryNode';
import { StashNode } from './stashNode';
import { ContextValues, ViewNode } from './viewNode';

export class StashesNode extends ViewNode<StashesView | RepositoriesView> {
	static key = ':stashes';
	static getId(repoPath: string): string {
		return `${RepositoryNode.getId(repoPath)}${this.key}`;
	}

	private _children: ViewNode[] | undefined;

	constructor(uri: GitUri, view: StashesView | RepositoriesView, parent: ViewNode, public readonly repo: Repository) {
		super(uri, view, parent);
	}

	override get id(): string {
		return StashesNode.getId(this.repo.path);
	}

	async getChildren(): Promise<ViewNode[]> {
		if (this._children == null) {
			const stash = await this.repo.getStash();
			if (stash == null) return [new MessageNode(this.view, this, 'No stashes could be found.')];

			this._children = [...Iterables.map(stash.commits.values(), c => new StashNode(this.view, this, c))];
		}

		return this._children;
	}

	getTreeItem(): TreeItem {
		const item = new TreeItem('Stashes', TreeItemCollapsibleState.Collapsed);
		item.id = this.id;
		item.contextValue = ContextValues.Stashes;

		item.iconPath = {
			dark: Container.instance.context.asAbsolutePath('images/dark/icon-stash.svg'),
			light: Container.instance.context.asAbsolutePath('images/light/icon-stash.svg'),
		};

		return item;
	}

	@gate()
	@debug()
	override refresh() {
		this._children = undefined;
	}
}
