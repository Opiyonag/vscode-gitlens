'use strict';
import { Range, TextEditor, Uri, window } from 'vscode';
import { UriComparer } from '../comparers';
import { BranchSorting, TagSorting } from '../configuration';
import { GlyphChars } from '../constants';
import { Container } from '../container';
import { GitBranch, GitRevision, RemoteResourceType } from '../git/git';
import { GitUri } from '../git/gitUri';
import { Logger } from '../logger';
import { ReferencePicker } from '../quickpicks';
import { Strings } from '../system';
import { StatusFileNode } from '../views/nodes';
import {
	ActiveEditorCommand,
	command,
	CommandContext,
	Commands,
	executeCommand,
	getCommandUri,
	isCommandContextViewNodeHasBranch,
	isCommandContextViewNodeHasCommit,
} from './common';
import { OpenOnRemoteCommandArgs } from './openOnRemote';

export interface OpenFileOnRemoteCommandArgs {
	branchOrTag?: string;
	clipboard?: boolean;
	range?: boolean;
	sha?: string;
	pickBranchOrTag?: boolean;
}

@command()
export class OpenFileOnRemoteCommand extends ActiveEditorCommand {
	constructor() {
		super([
			Commands.OpenFileOnRemote,
			Commands.Deprecated_OpenFileInRemote,
			Commands.CopyRemoteFileUrl,
			Commands.CopyRemoteFileUrlWithoutRange,
			Commands.OpenFileOnRemoteFrom,
			Commands.CopyRemoteFileUrlFrom,
		]);
	}

	protected override async preExecute(context: CommandContext, args?: OpenFileOnRemoteCommandArgs) {
		let uri = context.uri;

		if (context.command === Commands.CopyRemoteFileUrlWithoutRange) {
			args = { ...args, range: false };
		}

		if (isCommandContextViewNodeHasCommit(context)) {
			args = { ...args, range: false };

			if (
				context.command === Commands.CopyRemoteFileUrl ||
				context.command === Commands.CopyRemoteFileUrlWithoutRange ||
				context.command === Commands.CopyRemoteFileUrlFrom
			) {
				// If it is a StatusFileNode then don't include the sha, since it hasn't been pushed yet
				args.sha = context.node instanceof StatusFileNode ? undefined : context.node.commit.sha;
			} else if (isCommandContextViewNodeHasBranch(context)) {
				args.branchOrTag = context.node.branch?.name;
			}

			uri = context.node.uri;
		} else if (context.type === 'viewItem') {
			args = { ...args, range: false };

			uri = context.node.uri ?? context.uri;
		}

		if (
			context.command === Commands.CopyRemoteFileUrl ||
			context.command === Commands.CopyRemoteFileUrlWithoutRange ||
			context.command === Commands.CopyRemoteFileUrlFrom
		) {
			args = { ...args, clipboard: true };
			if (args.sha == null) {
				const uri = getCommandUri(context.uri, context.editor);
				if (uri != null) {
					const gitUri = await GitUri.fromUri(uri);
					if (gitUri.repoPath) {
						if (gitUri.sha == null) {
							const commit = await Container.instance.git.getCommitForFile(
								gitUri.repoPath,
								gitUri.fsPath,
								{
									firstIfNotFound: true,
								},
							);

							if (commit != null) {
								args.sha = commit.sha;
							}
						} else {
							args.sha = gitUri.sha;
						}
					}
				}
			}
		}

		if (context.command === Commands.OpenFileOnRemoteFrom || context.command === Commands.CopyRemoteFileUrlFrom) {
			args = { ...args, pickBranchOrTag: true, range: false };
		}

		return this.execute(context.editor, uri, args);
	}

	async execute(editor?: TextEditor, uri?: Uri, args?: OpenFileOnRemoteCommandArgs) {
		uri = getCommandUri(uri, editor);
		if (uri == null) return;

		const gitUri = await GitUri.fromUri(uri);
		if (!gitUri.repoPath) return;

		args = { range: true, ...args };

		try {
			let remotes = await Container.instance.git.getRemotes(gitUri.repoPath);
			const range =
				args.range && editor != null && UriComparer.equals(editor.document.uri, uri)
					? new Range(
							editor.selection.start.with({ line: editor.selection.start.line + 1 }),
							editor.selection.end.with({
								line: editor.selection.end.line + (editor.selection.end.character === 0 ? 0 : 1),
							}),
					  )
					: undefined;
			let sha = args.sha ?? gitUri.sha;

			if (args.branchOrTag == null && sha != null && !GitRevision.isSha(sha) && remotes.length !== 0) {
				const [remoteName, branchName] = Strings.splitSingle(sha, '/');
				if (branchName != null) {
					const remote = remotes.find(r => r.name === remoteName);
					if (remote != null) {
						args.branchOrTag = branchName;
						sha = undefined;

						remotes = [remote];
					}
				}
			}

			if ((args.sha == null && args.branchOrTag == null) || args.pickBranchOrTag) {
				let branch;
				if (!args.pickBranchOrTag) {
					branch = await Container.instance.git.getBranch(gitUri.repoPath);
				}

				if (branch?.upstream == null) {
					const pick = await ReferencePicker.show(
						gitUri.repoPath,
						args.clipboard
							? `Copy Remote File Url From${Strings.pad(GlyphChars.Dot, 2, 2)}${gitUri.relativePath}`
							: `Open File on Remote From${Strings.pad(GlyphChars.Dot, 2, 2)}${gitUri.relativePath}`,
						`Choose a branch or tag to ${args.clipboard ? 'copy' : 'open'} the file revision from`,
						{
							allowEnteringRefs: true,
							autoPick: true,
							// checkmarks: false,
							filter: { branches: b => b.remote || b.upstream != null },
							picked: args.branchOrTag,
							sort: {
								branches: { current: true, orderBy: BranchSorting.DateDesc },
								tags: { orderBy: TagSorting.DateDesc },
							},
						},
					);
					if (pick == null) return;

					if (pick.refType === 'branch') {
						if (pick.remote) {
							args.branchOrTag = GitBranch.getNameWithoutRemote(pick.name);

							const remoteName = GitBranch.getRemote(pick.name);
							const remote = remotes.find(r => r.name === remoteName);
							if (remote != null) {
								remotes = [remote];
							}
						} else {
							args.branchOrTag = pick.name;
						}
						sha = undefined;
					} else if (pick.refType === 'tag') {
						args.branchOrTag = pick.ref;
						sha = undefined;
					} else {
						args.branchOrTag = undefined;
						sha = pick.ref;
					}
				} else {
					args.branchOrTag = branch.name;
				}
			}

			void (await executeCommand<OpenOnRemoteCommandArgs>(Commands.OpenOnRemote, {
				resource: {
					type: sha == null ? RemoteResourceType.File : RemoteResourceType.Revision,
					branchOrTag: args.branchOrTag ?? 'HEAD',
					fileName: gitUri.relativePath,
					range: range,
					sha: sha ?? undefined,
				},
				repoPath: gitUri.repoPath,
				remotes: remotes,
				clipboard: args.clipboard,
			}));
		} catch (ex) {
			Logger.error(ex, 'OpenFileOnRemoteCommand');
			void window.showErrorMessage('Unable to open file on remote provider. See output channel for more details');
		}
	}
}
