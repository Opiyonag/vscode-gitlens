'use strict';
import * as paths from 'path';
import { TreeItem, TreeItemCollapsibleState } from 'vscode';
import { ViewFilesLayout } from '../../config';
import { Container } from '../../container';
import { CommitFormatter, GitStashCommit, GitStashReference } from '../../git/git';
import { Arrays, Strings } from '../../system';
import { ContextValues, FileNode, FolderNode, RepositoryNode, StashFileNode, ViewNode, ViewRefNode } from '../nodes';
import { RepositoriesView } from '../repositoriesView';
import { StashesView } from '../stashesView';

export class StashNode extends ViewRefNode<StashesView | RepositoriesView, GitStashReference> {
	static key = ':stash';
	static getId(repoPath: string, ref: string): string {
		return `${RepositoryNode.getId(repoPath)}${this.key}(${ref})`;
	}

	constructor(view: StashesView | RepositoriesView, parent: ViewNode, public readonly commit: GitStashCommit) {
		super(commit.toGitUri(), view, parent);
	}

	override toClipboard(): string {
		return this.commit.stashName;
	}

	override get id(): string {
		return StashNode.getId(this.commit.repoPath, this.commit.sha);
	}

	get ref(): GitStashReference {
		return this.commit;
	}

	async getChildren(): Promise<ViewNode[]> {
		// Ensure we have checked for untracked files
		await this.commit.checkForUntrackedFiles();

		let children: FileNode[] = this.commit.files.map(
			s => new StashFileNode(this.view, this, s, this.commit.toFileCommit(s)!),
		);

		if (this.view.config.files.layout !== ViewFilesLayout.List) {
			const hierarchy = Arrays.makeHierarchical(
				children,
				n => n.uri.relativePath.split('/'),
				(...parts: string[]) => Strings.normalizePath(paths.join(...parts)),
				this.view.config.files.compact,
			);

			const root = new FolderNode(this.view, this, this.repoPath, '', hierarchy);
			children = root.getChildren() as FileNode[];
		} else {
			children.sort((a, b) =>
				a.label!.localeCompare(b.label!, undefined, { numeric: true, sensitivity: 'base' }),
			);
		}
		return children;
	}

	getTreeItem(): TreeItem {
		const item = new TreeItem(
			CommitFormatter.fromTemplate(this.view.config.formats.stashes.label, this.commit, {
				messageTruncateAtNewLine: true,
				dateFormat: Container.instance.config.defaultDateFormat,
			}),
			TreeItemCollapsibleState.Collapsed,
		);
		item.id = this.id;
		item.description = CommitFormatter.fromTemplate(this.view.config.formats.stashes.description, this.commit, {
			messageTruncateAtNewLine: true,
			dateFormat: Container.instance.config.defaultDateFormat,
		});
		item.contextValue = ContextValues.Stash;
		item.tooltip = CommitFormatter.fromTemplate(`\${ago} (\${date})\n\n\${message}`, this.commit, {
			dateFormat: Container.instance.config.defaultDateFormat,
			// messageAutolinks: true,
		});

		return item;
	}
}
