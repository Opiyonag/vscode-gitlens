'use strict';
import { commands, env, TextDocumentShowOptions, Uri, window } from 'vscode';
import type { CreatePullRequestActionContext, OpenPullRequestActionContext } from '../api/gitlens';
import {
	Commands,
	DiffWithCommandArgs,
	DiffWithPreviousCommandArgs,
	DiffWithWorkingCommandArgs,
	executeActionCommand,
	executeCommand,
	executeEditorCommand,
	GitActions,
	OpenFileAtRevisionCommandArgs,
} from '../commands';
import { configuration, FileAnnotationType, ViewShowBranchComparison } from '../configuration';
import { BuiltInCommands, BuiltInGitCommands, ContextKeys, setContext } from '../constants';
import { Container } from '../container';
import { GitReference, GitRevision } from '../git/git';
import { GitService } from '../git/gitService';
import { GitUri } from '../git/gitUri';
import { debug } from '../system';
import { runGitCommandInTerminal } from '../terminal';
import {
	BranchesNode,
	BranchNode,
	BranchTrackingStatusNode,
	canClearNode,
	canEditNode,
	canViewDismissNode,
	CommitFileNode,
	CommitNode,
	CompareBranchNode,
	ContributorNode,
	ContributorsNode,
	FileHistoryNode,
	FileRevisionAsCommitNode,
	FolderNode,
	LineHistoryNode,
	MergeConflictFileNode,
	PageableViewNode,
	PagerNode,
	PullRequestNode,
	RemoteNode,
	RemotesNode,
	RepositoryFolderNode,
	RepositoryNode,
	ResultsFileNode,
	ResultsFilesNode,
	StashFileNode,
	StashNode,
	StatusFileNode,
	TagNode,
	TagsNode,
	ViewNode,
	ViewRefFileNode,
	ViewRefNode,
} from './nodes';

interface CompareSelectedInfo {
	ref: string;
	repoPath: string | undefined;
	uri?: Uri;
}

export class ViewCommands {
	constructor(private readonly container: Container) {
		commands.registerCommand('gitlens.views.clearNode', (n: ViewNode) => canClearNode(n) && n.clear(), this);
		commands.registerCommand(
			'gitlens.views.copy',
			async (selection: ViewNode | ViewNode[]) => {
				selection = Array.isArray(selection) ? selection : [selection];
				if (selection.length === 0) return;

				const data = selection
					.map(n => n.toClipboard?.())
					.filter(s => s != null && s.length > 0)
					.join(',');
				await env.clipboard.writeText(data);
			},
			this,
		);
		commands.registerCommand(
			'gitlens.views.dismissNode',
			(n: ViewNode) => canViewDismissNode(n.view) && n.view.dismissNode(n),
			this,
		);
		commands.registerCommand('gitlens.views.editNode', (n: ViewNode) => canEditNode(n) && n.edit(), this);
		commands.registerCommand(
			'gitlens.views.expandNode',
			(n: ViewNode) => n.view.reveal(n, { select: false, focus: false, expand: 3 }),
			this,
		);
		commands.registerCommand('gitlens.views.loadMoreChildren', (n: PagerNode) => n.loadMore(), this);
		commands.registerCommand('gitlens.views.loadAllChildren', (n: PagerNode) => n.loadAll(), this);
		commands.registerCommand(
			'gitlens.views.refreshNode',
			(n: ViewNode, reset?: boolean) => {
				if (reset == null && PageableViewNode.is(n)) {
					n.limit = undefined;
					n.view.resetNodeLastKnownLimit(n);
				}

				return n.view.refreshNode(n, reset == null ? true : reset);
			},
			this,
		);

		commands.registerCommand(
			'gitlens.views.setShowRelativeDateMarkersOn',
			() => this.setShowRelativeDateMarkers(true),
			this,
		);
		commands.registerCommand(
			'gitlens.views.setShowRelativeDateMarkersOff',
			() => this.setShowRelativeDateMarkers(false),
			this,
		);

		commands.registerCommand('gitlens.views.fetch', this.fetch, this);
		commands.registerCommand('gitlens.views.publishBranch', this.publishBranch, this);
		commands.registerCommand('gitlens.views.publishRepository', this.publishRepository, this);
		commands.registerCommand('gitlens.views.pull', this.pull, this);
		commands.registerCommand('gitlens.views.push', this.push, this);
		commands.registerCommand('gitlens.views.pushWithForce', n => this.push(n, true), this);
		commands.registerCommand('gitlens.views.closeRepository', this.closeRepository, this);

		commands.registerCommand('gitlens.views.setAsDefault', this.setAsDefault, this);
		commands.registerCommand('gitlens.views.unsetAsDefault', this.unsetAsDefault, this);

		commands.registerCommand('gitlens.views.openInTerminal', this.openInTerminal, this);
		commands.registerCommand('gitlens.views.star', this.star, this);
		commands.registerCommand('gitlens.views.unstar', this.unstar, this);

		commands.registerCommand('gitlens.views.browseRepoAtRevision', this.browseRepoAtRevision, this);
		commands.registerCommand(
			'gitlens.views.browseRepoAtRevisionInNewWindow',
			n => this.browseRepoAtRevision(n, { openInNewWindow: true }),
			this,
		);
		commands.registerCommand(
			'gitlens.views.browseRepoBeforeRevision',
			n => this.browseRepoAtRevision(n, { before: true }),
			this,
		);
		commands.registerCommand(
			'gitlens.views.browseRepoBeforeRevisionInNewWindow',
			n => this.browseRepoAtRevision(n, { before: true, openInNewWindow: true }),
			this,
		);

		commands.registerCommand('gitlens.views.addAuthors', this.addAuthors, this);
		commands.registerCommand('gitlens.views.addAuthor', this.addAuthors, this);

		commands.registerCommand('gitlens.views.openChanges', this.openChanges, this);
		commands.registerCommand('gitlens.views.openChangesWithWorking', this.openChangesWithWorking, this);
		commands.registerCommand(
			'gitlens.views.openPreviousChangesWithWorking',
			this.openPreviousChangesWithWorking,
			this,
		);
		commands.registerCommand('gitlens.views.openFile', this.openFile, this);
		commands.registerCommand('gitlens.views.openFileRevision', this.openRevision, this);
		commands.registerCommand('gitlens.views.openChangedFiles', this.openFiles, this);
		commands.registerCommand('gitlens.views.openChangedFileDiffs', this.openAllChanges, this);
		commands.registerCommand('gitlens.views.openChangedFileDiffsWithWorking', this.openAllChangesWithWorking, this);
		commands.registerCommand('gitlens.views.openChangedFileRevisions', this.openRevisions, this);
		commands.registerCommand('gitlens.views.applyChanges', this.applyChanges, this);
		commands.registerCommand('gitlens.views.highlightChanges', this.highlightChanges, this);
		commands.registerCommand('gitlens.views.highlightRevisionChanges', this.highlightRevisionChanges, this);
		commands.registerCommand('gitlens.views.restore', this.restore, this);
		commands.registerCommand('gitlens.views.switchToBranch', this.switch, this);
		commands.registerCommand('gitlens.views.switchToAnotherBranch', this.switch, this);
		commands.registerCommand('gitlens.views.switchToCommit', this.switch, this);
		commands.registerCommand('gitlens.views.switchToTag', this.switch, this);
		commands.registerCommand('gitlens.views.addRemote', this.addRemote, this);
		commands.registerCommand('gitlens.views.pruneRemote', this.pruneRemote, this);

		commands.registerCommand('gitlens.views.stageDirectory', this.stageDirectory, this);
		commands.registerCommand('gitlens.views.stageFile', this.stageFile, this);
		commands.registerCommand('gitlens.views.unstageDirectory', this.unstageDirectory, this);
		commands.registerCommand('gitlens.views.unstageFile', this.unstageFile, this);

		commands.registerCommand('gitlens.views.compareAncestryWithWorking', this.compareAncestryWithWorking, this);
		commands.registerCommand('gitlens.views.compareWithHead', this.compareHeadWith, this);
		commands.registerCommand('gitlens.views.compareWithUpstream', this.compareWithUpstream, this);
		commands.registerCommand('gitlens.views.compareWithSelected', this.compareWithSelected, this);
		commands.registerCommand('gitlens.views.selectForCompare', this.selectForCompare, this);
		commands.registerCommand('gitlens.views.compareFileWithSelected', this.compareFileWithSelected, this);
		commands.registerCommand('gitlens.views.selectFileForCompare', this.selectFileForCompare, this);
		commands.registerCommand('gitlens.views.compareWithWorking', this.compareWorkingWith, this);

		commands.registerCommand(
			'gitlens.views.setBranchComparisonToWorking',
			n => this.setBranchComparison(n, ViewShowBranchComparison.Working),
			this,
		);
		commands.registerCommand(
			'gitlens.views.setBranchComparisonToBranch',
			n => this.setBranchComparison(n, ViewShowBranchComparison.Branch),
			this,
		);

		commands.registerCommand('gitlens.views.cherryPick', this.cherryPick, this);
		commands.registerCommand('gitlens.views.createBranch', this.createBranch, this);
		commands.registerCommand('gitlens.views.deleteBranch', this.deleteBranch, this);
		commands.registerCommand('gitlens.views.renameBranch', this.renameBranch, this);
		commands.registerCommand('gitlens.views.deleteStash', this.deleteStash, this);
		commands.registerCommand('gitlens.views.createTag', this.createTag, this);
		commands.registerCommand('gitlens.views.deleteTag', this.deleteTag, this);

		commands.registerCommand('gitlens.views.mergeBranchInto', this.merge, this);
		commands.registerCommand('gitlens.views.pushToCommit', this.pushToCommit, this);

		commands.registerCommand('gitlens.views.rebaseOntoBranch', this.rebase, this);
		commands.registerCommand('gitlens.views.rebaseOntoUpstream', this.rebaseToRemote, this);
		commands.registerCommand('gitlens.views.rebaseOntoCommit', this.rebase, this);

		commands.registerCommand('gitlens.views.resetCommit', this.resetCommit, this);
		commands.registerCommand('gitlens.views.resetToCommit', this.resetToCommit, this);
		commands.registerCommand('gitlens.views.revert', this.revert, this);
		commands.registerCommand('gitlens.views.undoCommit', this.undoCommit, this);

		commands.registerCommand('gitlens.views.terminalRemoveRemote', this.terminalRemoveRemote, this);

		commands.registerCommand('gitlens.views.createPullRequest', this.createPullRequest, this);
		commands.registerCommand('gitlens.views.openPullRequest', this.openPullRequest, this);
	}

	@debug()
	private addAuthors(node?: ContributorNode | ContributorsNode) {
		if (node != null && !(node instanceof ContributorNode) && !(node instanceof ContributorsNode)) {
			return Promise.resolve();
		}

		return GitActions.Contributor.addAuthors(
			node?.uri.repoPath,
			node instanceof ContributorNode ? node.contributor : undefined,
		);
	}

	@debug()
	private addRemote(node?: RemotesNode) {
		return GitActions.Remote.add(node?.repoPath);
	}

	@debug()
	private applyChanges(node: ViewRefFileNode) {
		if (!(node instanceof ViewRefFileNode)) return Promise.resolve();

		if (node instanceof ResultsFileNode) {
			return GitActions.Commit.applyChanges(
				node.file,
				GitReference.create(node.ref1, node.repoPath),
				GitReference.create(node.ref2, node.repoPath),
			);
		}

		if (node.ref == null || node.ref.ref === 'HEAD') return Promise.resolve();

		return GitActions.Commit.applyChanges(node.file, node.ref);
	}

	@debug()
	private browseRepoAtRevision(node: ViewRefNode, options?: { before?: boolean; openInNewWindow?: boolean }) {
		if (!(node instanceof ViewRefNode)) return Promise.resolve();

		return GitActions.browseAtRevision(node.uri, {
			before: options?.before,
			openInNewWindow: options?.openInNewWindow,
		});
	}

	@debug()
	private cherryPick(node: CommitNode) {
		if (!(node instanceof CommitNode)) return Promise.resolve();

		return GitActions.cherryPick(node.repoPath, node.ref);
	}

	@debug()
	private closeRepository(node: RepositoryNode | RepositoryFolderNode) {
		if (!(node instanceof RepositoryNode) && !(node instanceof RepositoryFolderNode)) return;

		node.repo.closed = true;
	}

	@debug()
	private async createBranch(node?: ViewRefNode | BranchesNode | BranchTrackingStatusNode) {
		let from =
			node instanceof ViewRefNode
				? node?.ref
				: node instanceof BranchTrackingStatusNode
				? node.branch
				: undefined;
		if (from == null) {
			const branch = await this.container.git.getBranch(
				node?.repoPath ?? (await this.container.git.getActiveRepoPath()),
			);
			from = branch;
		}
		return GitActions.Branch.create(node?.repoPath, from);
	}

	@debug()
	private async createPullRequest(node: BranchNode | BranchTrackingStatusNode) {
		if (!(node instanceof BranchNode) && !(node instanceof BranchTrackingStatusNode)) {
			return Promise.resolve();
		}

		const remote = await node.branch.getRemote();

		return executeActionCommand<CreatePullRequestActionContext>('createPullRequest', {
			repoPath: node.repoPath,
			remote:
				remote != null
					? {
							name: remote.name,
							provider:
								remote.provider != null
									? {
											id: remote.provider.id,
											name: remote.provider.name,
											domain: remote.provider.domain,
									  }
									: undefined,
							url: remote.url,
					  }
					: undefined,
			branch: {
				name: node.branch.name,
				upstream: node.branch.upstream?.name,
				isRemote: node.branch.remote,
			},
		});
	}

	@debug()
	private async createTag(node?: ViewRefNode | TagsNode | BranchTrackingStatusNode) {
		let from =
			node instanceof ViewRefNode
				? node?.ref
				: node instanceof BranchTrackingStatusNode
				? node.branch
				: undefined;
		if (from == null) {
			const branch = await this.container.git.getBranch(
				node?.repoPath ?? (await this.container.git.getActiveRepoPath()),
			);
			from = branch;
		}
		return GitActions.Tag.create(node?.repoPath, from);
	}

	@debug()
	private deleteBranch(node: BranchNode) {
		if (!(node instanceof BranchNode)) return Promise.resolve();

		return GitActions.Branch.remove(node.repoPath, node.branch);
	}

	@debug()
	private deleteStash(node: StashNode) {
		if (!(node instanceof StashNode)) return Promise.resolve();

		return GitActions.Stash.drop(node.repoPath, node.commit);
	}

	@debug()
	private deleteTag(node: TagNode) {
		if (!(node instanceof TagNode)) return Promise.resolve();

		return GitActions.Tag.remove(node.repoPath, node.tag);
	}

	@debug()
	private fetch(node: RemoteNode | RepositoryNode | RepositoryFolderNode | BranchNode | BranchTrackingStatusNode) {
		if (node instanceof RepositoryNode || node instanceof RepositoryFolderNode) return GitActions.fetch(node.repo);
		if (node instanceof RemoteNode) return GitActions.Remote.fetch(node.remote.repoPath, node.remote.name);
		if (node instanceof BranchNode || node instanceof BranchTrackingStatusNode) {
			return GitActions.fetch(node.repoPath, node.root ? undefined : node.branch);
		}

		return Promise.resolve();
	}

	@debug()
	private async highlightChanges(node: CommitFileNode | StashFileNode | FileRevisionAsCommitNode | ResultsFileNode) {
		if (
			!(node instanceof CommitFileNode) &&
			!(node instanceof StashFileNode) &&
			!(node instanceof FileRevisionAsCommitNode) &&
			!(node instanceof ResultsFileNode)
		) {
			return;
		}

		void (await this.openFile(node, { preserveFocus: true, preview: true }));
		void (await this.container.fileAnnotations.toggle(
			window.activeTextEditor,
			FileAnnotationType.Changes,
			{ sha: node.ref.ref },
			true,
		));
	}

	@debug()
	private async highlightRevisionChanges(
		node: CommitFileNode | StashFileNode | FileRevisionAsCommitNode | ResultsFileNode,
	) {
		if (
			!(node instanceof CommitFileNode) &&
			!(node instanceof StashFileNode) &&
			!(node instanceof FileRevisionAsCommitNode) &&
			!(node instanceof ResultsFileNode)
		) {
			return;
		}

		void (await this.openFile(node, { preserveFocus: true, preview: true }));
		void (await this.container.fileAnnotations.toggle(
			window.activeTextEditor,
			FileAnnotationType.Changes,
			{ sha: node.ref.ref, only: true },
			true,
		));
	}

	@debug()
	private merge(node: BranchNode | TagNode) {
		if (!(node instanceof BranchNode) && !(node instanceof TagNode)) return Promise.resolve();

		return GitActions.merge(node.repoPath, node instanceof BranchNode ? node.branch : node.tag);
	}

	@debug()
	private pushToCommit(node: CommitNode | FileRevisionAsCommitNode) {
		if (!(node instanceof CommitNode) && !(node instanceof FileRevisionAsCommitNode)) return Promise.resolve();

		return GitActions.push(node.repoPath, false, node.commit);
	}

	@debug()
	private openPullRequest(node: PullRequestNode) {
		if (!(node instanceof PullRequestNode)) return Promise.resolve();

		return executeActionCommand<OpenPullRequestActionContext>('openPullRequest', {
			repoPath: node.uri.repoPath!,
			provider: {
				id: node.pullRequest.provider.id,
				name: node.pullRequest.provider.name,
				domain: node.pullRequest.provider.domain,
			},
			pullRequest: {
				id: node.pullRequest.id,
				url: node.pullRequest.url,
			},
		});
	}

	@debug()
	private openInTerminal(node: RepositoryNode | RepositoryFolderNode) {
		if (!(node instanceof RepositoryNode) && !(node instanceof RepositoryFolderNode)) return Promise.resolve();

		return commands.executeCommand(BuiltInCommands.OpenInTerminal, Uri.file(node.repo.path));
	}

	@debug()
	private async pruneRemote(node: RemoteNode) {
		if (!(node instanceof RemoteNode)) return Promise.resolve();

		return GitActions.Remote.prune(node.repo, node.remote.name);
	}

	@debug()
	private publishBranch(node: BranchNode | BranchTrackingStatusNode) {
		if (node instanceof BranchNode || node instanceof BranchTrackingStatusNode) {
			return GitActions.push(node.repoPath, undefined, node.branch);
		}
		return Promise.resolve();
	}

	@debug()
	private publishRepository(node: BranchNode | BranchTrackingStatusNode) {
		if (node instanceof BranchNode || node instanceof BranchTrackingStatusNode) {
			return commands.executeCommand(BuiltInGitCommands.Publish, Uri.file(node.repoPath));
		}
		return Promise.resolve();
	}

	@debug()
	private pull(node: RepositoryNode | RepositoryFolderNode | BranchNode | BranchTrackingStatusNode) {
		if (node instanceof RepositoryNode || node instanceof RepositoryFolderNode) return GitActions.pull(node.repo);
		if (node instanceof BranchNode || node instanceof BranchTrackingStatusNode) {
			return GitActions.pull(node.repoPath, node.root ? undefined : node.branch);
		}

		return Promise.resolve();
	}

	@debug()
	private push(
		node:
			| RepositoryNode
			| RepositoryFolderNode
			| BranchNode
			| BranchTrackingStatusNode
			| CommitNode
			| FileRevisionAsCommitNode,
		force?: boolean,
	) {
		if (node instanceof RepositoryNode || node instanceof RepositoryFolderNode) {
			return GitActions.push(node.repo, force);
		}

		if (node instanceof BranchNode || node instanceof BranchTrackingStatusNode) {
			return GitActions.push(node.repoPath, undefined, node.root ? undefined : node.branch);
		}

		if (node instanceof CommitNode || node instanceof FileRevisionAsCommitNode) {
			if (node.isTip) {
				return GitActions.push(node.repoPath, force);
			}

			return this.pushToCommit(node);
		}

		return Promise.resolve();
	}

	@debug()
	private rebase(node: BranchNode | CommitNode | FileRevisionAsCommitNode | TagNode) {
		if (
			!(node instanceof BranchNode) &&
			!(node instanceof CommitNode) &&
			!(node instanceof FileRevisionAsCommitNode) &&
			!(node instanceof TagNode)
		) {
			return Promise.resolve();
		}

		return GitActions.rebase(node.repoPath, node.ref);
	}

	@debug()
	private rebaseToRemote(node: BranchNode | BranchTrackingStatusNode) {
		if (!(node instanceof BranchNode) && !(node instanceof BranchTrackingStatusNode)) return Promise.resolve();

		const upstream = node instanceof BranchNode ? node.branch.upstream?.name : node.status.upstream;
		if (upstream == null) return Promise.resolve();

		return GitActions.rebase(
			node.repoPath,
			GitReference.create(upstream, node.repoPath, {
				refType: 'branch',
				name: upstream,
				remote: true,
			}),
		);
	}

	@debug()
	private renameBranch(node: BranchNode) {
		if (!(node instanceof BranchNode)) return Promise.resolve();

		return GitActions.Branch.rename(node.repoPath, node.branch);
	}

	@debug()
	private resetCommit(node: CommitNode | FileRevisionAsCommitNode) {
		if (!(node instanceof CommitNode) && !(node instanceof FileRevisionAsCommitNode)) return Promise.resolve();

		return GitActions.reset(
			node.repoPath,
			GitReference.create(`${node.ref.ref}^`, node.ref.repoPath, {
				refType: 'revision',
				name: `${node.ref.name}^`,
				message: node.ref.message,
			}),
		);
	}

	@debug()
	private resetToCommit(node: CommitNode | FileRevisionAsCommitNode) {
		if (!(node instanceof CommitNode) && !(node instanceof FileRevisionAsCommitNode)) return Promise.resolve();

		return GitActions.reset(node.repoPath, node.ref);
	}

	@debug()
	private restore(node: ViewRefFileNode) {
		if (!(node instanceof ViewRefFileNode)) return Promise.resolve();

		return GitActions.Commit.restoreFile(node.fileName, node.ref);
	}

	@debug()
	private revert(node: CommitNode | FileRevisionAsCommitNode) {
		if (!(node instanceof CommitNode) && !(node instanceof FileRevisionAsCommitNode)) return Promise.resolve();

		return GitActions.revert(node.repoPath, node.ref);
	}

	@debug()
	private setAsDefault(node: RemoteNode) {
		if (!(node instanceof RemoteNode)) return Promise.resolve();

		return node.setAsDefault();
	}

	@debug()
	private setBranchComparison(node: ViewNode, comparisonType: Exclude<ViewShowBranchComparison, false>) {
		if (!(node instanceof CompareBranchNode)) return undefined;

		return node.setComparisonType(comparisonType);
	}

	@debug()
	private setShowRelativeDateMarkers(enabled: boolean) {
		return configuration.updateEffective('views.showRelativeDateMarkers', enabled);
	}

	@debug()
	private async stageFile(node: CommitFileNode | FileRevisionAsCommitNode | StatusFileNode) {
		if (
			!(node instanceof CommitFileNode) &&
			!(node instanceof FileRevisionAsCommitNode) &&
			!(node instanceof StatusFileNode)
		) {
			return;
		}

		void (await this.container.git.stageFile(node.repoPath, node.file.fileName));
		void node.triggerChange();
	}

	@debug()
	private async stageDirectory(node: FolderNode) {
		if (!(node instanceof FolderNode) || !node.relativePath) return;

		void (await this.container.git.stageDirectory(node.repoPath, node.relativePath));
		void node.triggerChange();
	}

	@debug()
	private star(node: BranchNode | RepositoryNode | RepositoryFolderNode) {
		if (
			!(node instanceof BranchNode) &&
			!(node instanceof RepositoryNode) &&
			!(node instanceof RepositoryFolderNode)
		) {
			return Promise.resolve();
		}

		return node.star();
	}

	@debug()
	private switch(node?: ViewRefNode | BranchesNode) {
		if (node == null) {
			return GitActions.switchTo(this.container.git.getHighlanderRepoPath());
		}

		if (!(node instanceof ViewRefNode) && !(node instanceof BranchesNode)) return Promise.resolve();

		return GitActions.switchTo(
			node.repoPath,
			node instanceof BranchesNode || (node instanceof BranchNode && node.branch.current) ? undefined : node.ref,
		);
	}

	@debug()
	private async undoCommit(node: CommitNode | FileRevisionAsCommitNode) {
		if (!(node instanceof CommitNode) && !(node instanceof FileRevisionAsCommitNode)) return;

		const repo = await GitService.getOrOpenBuiltInGitRepository(node.repoPath);
		const commit = await repo?.getCommit('HEAD');

		if (commit?.hash !== node.ref.ref) {
			void window.showWarningMessage(
				`Commit ${GitReference.toString(node.ref, {
					capitalize: true,
					icon: false,
				})} cannot be undone, because it is no longer the most recent commit.`,
			);

			return;
		}

		await commands.executeCommand(BuiltInGitCommands.UndoCommit, node.repoPath);
	}

	@debug()
	private unsetAsDefault(node: RemoteNode) {
		if (!(node instanceof RemoteNode)) return Promise.resolve();

		return node.setAsDefault(false);
	}

	@debug()
	private async unstageFile(node: CommitFileNode | FileRevisionAsCommitNode | StatusFileNode) {
		if (
			!(node instanceof CommitFileNode) &&
			!(node instanceof FileRevisionAsCommitNode) &&
			!(node instanceof StatusFileNode)
		) {
			return;
		}

		void (await this.container.git.unStageFile(node.repoPath, node.file.fileName));
		void node.triggerChange();
	}

	@debug()
	private async unstageDirectory(node: FolderNode) {
		if (!(node instanceof FolderNode) || !node.relativePath) return;

		void (await this.container.git.unStageDirectory(node.repoPath, node.relativePath));
		void node.triggerChange();
	}

	@debug()
	private unstar(node: BranchNode | RepositoryNode | RepositoryFolderNode) {
		if (
			!(node instanceof BranchNode) &&
			!(node instanceof RepositoryNode) &&
			!(node instanceof RepositoryFolderNode)
		) {
			return Promise.resolve();
		}

		return node.unstar();
	}

	@debug()
	private compareHeadWith(node: ViewRefNode) {
		if (!(node instanceof ViewRefNode)) return Promise.resolve();

		return this.container.searchAndCompareView.compare(node.repoPath, 'HEAD', node.ref);
	}

	@debug()
	private compareWithUpstream(node: BranchNode) {
		if (!(node instanceof BranchNode)) return Promise.resolve();
		if (node.branch.upstream == null) return Promise.resolve();

		return this.container.searchAndCompareView.compare(node.repoPath, node.ref, node.branch.upstream.name);
	}

	@debug()
	private compareWorkingWith(node: ViewRefNode) {
		if (!(node instanceof ViewRefNode)) return Promise.resolve();

		return this.container.searchAndCompareView.compare(node.repoPath, '', node.ref);
	}

	@debug()
	private async compareAncestryWithWorking(node: BranchNode) {
		if (!(node instanceof BranchNode)) return undefined;

		const branch = await this.container.git.getBranch(node.repoPath);
		if (branch == null) return undefined;

		const commonAncestor = await this.container.git.getMergeBase(node.repoPath, branch.ref, node.ref.ref);
		if (commonAncestor == null) return undefined;

		return this.container.searchAndCompareView.compare(
			node.repoPath,
			{ ref: commonAncestor, label: `ancestry with ${node.ref.ref} (${GitRevision.shorten(commonAncestor)})` },
			'',
		);
	}

	@debug()
	private compareWithSelected(node: ViewRefNode) {
		if (!(node instanceof ViewRefNode)) return;

		this.container.searchAndCompareView.compareWithSelected(node.repoPath, node.ref);
	}

	@debug()
	private selectForCompare(node: ViewRefNode) {
		if (!(node instanceof ViewRefNode)) return;

		this.container.searchAndCompareView.selectForCompare(node.repoPath, node.ref);
	}

	@debug()
	private compareFileWithSelected(node: ViewRefFileNode) {
		if (this._selectedFile == null || !(node instanceof ViewRefFileNode) || node.ref == null) {
			return Promise.resolve();
		}

		if (this._selectedFile.repoPath !== node.repoPath) {
			this.selectFileForCompare(node);
			return Promise.resolve();
		}

		const selected = this._selectedFile;

		this._selectedFile = undefined;
		void setContext(ContextKeys.ViewsCanCompareFile, false);

		return executeCommand<DiffWithCommandArgs>(Commands.DiffWith, {
			repoPath: selected.repoPath,
			lhs: {
				sha: selected.ref,
				uri: selected.uri!,
			},
			rhs: {
				sha: node.ref.ref,
				uri: node.uri,
			},
		});
	}

	private _selectedFile: CompareSelectedInfo | undefined;

	@debug()
	private selectFileForCompare(node: ViewRefFileNode) {
		if (!(node instanceof ViewRefFileNode) || node.ref == null) return;

		this._selectedFile = {
			ref: node.ref.ref,
			repoPath: node.repoPath,
			uri: node.uri,
		};
		void setContext(ContextKeys.ViewsCanCompareFile, true);
	}

	@debug()
	private async openAllChanges(node: CommitNode | StashNode | ResultsFilesNode, options?: TextDocumentShowOptions) {
		if (!(node instanceof CommitNode) && !(node instanceof StashNode) && !(node instanceof ResultsFilesNode)) {
			return undefined;
		}

		if (node instanceof ResultsFilesNode) {
			const { files: diff } = await node.getFilesQueryResults();
			if (diff == null || diff.length === 0) return undefined;

			return GitActions.Commit.openAllChanges(
				diff,
				{
					repoPath: node.repoPath,
					ref1: node.ref1,
					ref2: node.ref2,
				},
				options,
			);
		}

		return GitActions.Commit.openAllChanges(node.commit, options);
	}

	@debug()
	private openChanges(node: ViewRefFileNode | MergeConflictFileNode | StatusFileNode) {
		if (
			!(node instanceof ViewRefFileNode) &&
			!(node instanceof MergeConflictFileNode) &&
			!(node instanceof StatusFileNode)
		) {
			return;
		}

		if (node instanceof MergeConflictFileNode) {
			void executeCommand<DiffWithCommandArgs>(Commands.DiffWith, {
				lhs: {
					sha: node.status.HEAD.ref,
					uri: GitUri.fromFile(node.file, node.repoPath, undefined, true),
				},
				rhs: {
					sha: 'HEAD',
					uri: GitUri.fromFile(node.file, node.repoPath),
				},
				repoPath: node.repoPath,
				line: 0,
				showOptions: {
					preserveFocus: false,
					preview: false,
				},
			});

			return;
		}

		const command = node.getCommand();
		if (command?.arguments == null) return;

		switch (command.command) {
			case Commands.DiffWith: {
				const [args] = command.arguments as [DiffWithCommandArgs];
				args.showOptions!.preview = false;
				void executeCommand<DiffWithCommandArgs>(command.command, args);
				break;
			}
			case Commands.DiffWithPrevious: {
				const [, args] = command.arguments as [Uri, DiffWithPreviousCommandArgs];
				args.showOptions!.preview = false;
				void executeEditorCommand<DiffWithPreviousCommandArgs>(command.command, undefined, args);
				break;
			}
			default:
				throw new Error(`Unexpected command: ${command.command}`);
		}

		// TODO@eamodio Revisit this
		// return GitActions.Commit.openChanges(node.file, node instanceof ViewRefFileNode ? node.ref : node.commit, {
		// 	preserveFocus: true,
		// 	preview: false,
		// });
	}

	@debug()
	private async openAllChangesWithWorking(
		node: CommitNode | StashNode | ResultsFilesNode,
		options?: TextDocumentShowOptions,
	) {
		if (!(node instanceof CommitNode) && !(node instanceof StashNode) && !(node instanceof ResultsFilesNode)) {
			return undefined;
		}

		if (node instanceof ResultsFilesNode) {
			const { files: diff } = await node.getFilesQueryResults();
			if (diff == null || diff.length === 0) return undefined;

			return GitActions.Commit.openAllChangesWithWorking(
				diff,
				{
					repoPath: node.repoPath,
					ref: node.ref1 || node.ref2,
				},
				options,
			);
		}

		return GitActions.Commit.openAllChangesWithWorking(node.commit, options);

		// options = { preserveFocus: false, preview: false, ...options };

		// let repoPath: string;
		// let files;
		// let ref: string;

		// if (node instanceof ResultsFilesNode) {
		// 	const { diff } = await node.getFilesQueryResults();
		// 	if (diff == null || diff.length === 0) return;

		// 	repoPath = node.repoPath;
		// 	files = diff;
		// 	ref = node.ref1 || node.ref2;
		// } else {
		// 	repoPath = node.commit.repoPath;
		// 	files = node.commit.files;
		// 	ref = node.commit.sha;
		// }

		// if (files.length > 20) {
		// 	const result = await window.showWarningMessage(
		// 		`Are your sure you want to open all ${files.length} files?`,
		// 		{ title: 'Yes' },
		// 		{ title: 'No', isCloseAffordance: true },
		// 	);
		// 	if (result == null || result.title === 'No') return;
		// }

		// for (const file of files) {
		// 	if (file.status === 'A' || file.status === 'D') continue;

		// 	const args: DiffWithWorkingCommandArgs = {
		// 		showOptions: options,
		// 	};

		// 	const uri = GitUri.fromFile(file, repoPath, ref);
		// 	await commands.executeCommand(Commands.DiffWithWorking, uri, args);
		// }
	}

	@debug()
	private async openChangesWithWorking(node: ViewRefFileNode | MergeConflictFileNode | StatusFileNode) {
		if (
			!(node instanceof ViewRefFileNode) &&
			!(node instanceof MergeConflictFileNode) &&
			!(node instanceof StatusFileNode)
		) {
			return Promise.resolve();
		}

		if (node instanceof StatusFileNode) {
			return executeEditorCommand<DiffWithWorkingCommandArgs>(Commands.DiffWithWorking, undefined, {
				uri: node.uri,
				showOptions: {
					preserveFocus: true,
					preview: true,
				},
			});
		} else if (node instanceof MergeConflictFileNode) {
			return executeEditorCommand<DiffWithWorkingCommandArgs>(Commands.DiffWithWorking, undefined, {
				uri: node.baseUri,
				showOptions: {
					preserveFocus: true,
					preview: true,
				},
			});
		} else if (node instanceof FileRevisionAsCommitNode && node.commit.hasConflicts) {
			const baseUri = await node.getConflictBaseUri();
			if (baseUri != null) {
				return executeEditorCommand<DiffWithWorkingCommandArgs>(Commands.DiffWithWorking, undefined, {
					uri: baseUri,
					showOptions: {
						preserveFocus: true,
						preview: true,
					},
				});
			}
		}

		return GitActions.Commit.openChangesWithWorking(node.file, { repoPath: node.repoPath, ref: node.ref.ref });
	}

	@debug()
	private async openPreviousChangesWithWorking(node: ViewRefFileNode) {
		if (!(node instanceof ViewRefFileNode)) return Promise.resolve();

		return GitActions.Commit.openChangesWithWorking(node.file, {
			repoPath: node.repoPath,
			ref: `${node.ref.ref}^`,
		});
	}

	@debug()
	private openFile(
		node: ViewRefFileNode | MergeConflictFileNode | StatusFileNode | FileHistoryNode | LineHistoryNode,
		options?: TextDocumentShowOptions,
	) {
		if (
			!(node instanceof ViewRefFileNode) &&
			!(node instanceof MergeConflictFileNode) &&
			!(node instanceof StatusFileNode) &&
			!(node instanceof FileHistoryNode) &&
			!(node instanceof LineHistoryNode)
		) {
			return Promise.resolve();
		}

		return GitActions.Commit.openFile(node.uri, {
			preserveFocus: true,
			preview: false,
			...options,
		});
	}

	@debug()
	private async openFiles(node: CommitNode | StashNode | ResultsFilesNode) {
		if (!(node instanceof CommitNode) && !(node instanceof StashNode) && !(node instanceof ResultsFilesNode)) {
			return undefined;
		}

		if (node instanceof ResultsFilesNode) {
			const { files: diff } = await node.getFilesQueryResults();
			if (diff == null || diff.length === 0) return undefined;

			return GitActions.Commit.openFiles(diff, node.repoPath, node.ref1 || node.ref2);
		}

		return GitActions.Commit.openFiles(node.commit);
	}

	@debug()
	private openRevision(
		node:
			| CommitFileNode
			| FileRevisionAsCommitNode
			| ResultsFileNode
			| StashFileNode
			| MergeConflictFileNode
			| StatusFileNode,
		options?: OpenFileAtRevisionCommandArgs,
	) {
		if (
			!(node instanceof CommitFileNode) &&
			!(node instanceof FileRevisionAsCommitNode) &&
			!(node instanceof ResultsFileNode) &&
			!(node instanceof StashFileNode) &&
			!(node instanceof MergeConflictFileNode) &&
			!(node instanceof StatusFileNode)
		) {
			return Promise.resolve();
		}

		options = { showOptions: { preserveFocus: true, preview: false }, ...options };

		let uri = options.revisionUri;
		if (uri == null) {
			if (node instanceof ResultsFileNode || node instanceof MergeConflictFileNode) {
				uri = GitUri.toRevisionUri(node.uri);
			} else {
				uri =
					node.commit.status === 'D'
						? GitUri.toRevisionUri(
								node.commit.previousSha!,
								node.commit.previousUri.fsPath,
								node.commit.repoPath,
						  )
						: GitUri.toRevisionUri(node.uri);
			}
		}

		return GitActions.Commit.openFileAtRevision(
			uri,
			options.showOptions ?? { preserveFocus: true, preview: false },
		);
	}

	@debug()
	private async openRevisions(node: CommitNode | StashNode | ResultsFilesNode, _options?: TextDocumentShowOptions) {
		if (!(node instanceof CommitNode) && !(node instanceof StashNode) && !(node instanceof ResultsFilesNode)) {
			return undefined;
		}

		if (node instanceof ResultsFilesNode) {
			const { files: diff } = await node.getFilesQueryResults();
			if (diff == null || diff.length === 0) return undefined;

			return GitActions.Commit.openFilesAtRevision(diff, node.repoPath, node.ref1, node.ref2);
		}

		return GitActions.Commit.openFilesAtRevision(node.commit);
	}

	private terminalRemoveRemote(node: RemoteNode) {
		if (!(node instanceof RemoteNode)) return;

		runGitCommandInTerminal('remote', `remove ${node.remote.name}`, node.remote.repoPath);
	}
}
