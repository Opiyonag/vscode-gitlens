'use strict';
import {
	CancellationToken,
	CodeLens,
	CodeLensProvider,
	Command,
	commands,
	DocumentSelector,
	DocumentSymbol,
	Event,
	EventEmitter,
	Location,
	Position,
	Range,
	SymbolInformation,
	SymbolKind,
	TextDocument,
	Uri,
} from 'vscode';
import {
	command,
	Commands,
	DiffWithPreviousCommandArgs,
	OpenOnRemoteCommandArgs,
	ShowCommitsInViewCommandArgs,
	ShowQuickCommitCommandArgs,
	ShowQuickCommitFileCommandArgs,
	ShowQuickFileHistoryCommandArgs,
	ToggleFileChangesAnnotationCommandArgs,
} from '../commands';
import {
	CodeLensCommand,
	CodeLensConfig,
	CodeLensLanguageScope,
	CodeLensScopes,
	configuration,
	FileAnnotationType,
} from '../configuration';
import { BuiltInCommands, DocumentSchemes } from '../constants';
import { Container } from '../container';
import { GitBlame, GitBlameLines, GitCommit, RemoteResourceType } from '../git/git';
import { GitUri } from '../git/gitUri';
import { Logger } from '../logger';
import { Functions, Iterables } from '../system';

export class GitRecentChangeCodeLens extends CodeLens {
	constructor(
		public readonly languageId: string,
		public readonly symbol: DocumentSymbol | SymbolInformation,
		public readonly uri: GitUri | undefined,
		private readonly blame: (() => GitBlameLines | undefined) | undefined,
		public readonly blameRange: Range,
		public readonly isFullRange: boolean,
		range: Range,
		public readonly desiredCommand: CodeLensCommand | false,
		command?: Command | undefined,
	) {
		super(range, command);
	}

	getBlame(): GitBlameLines | undefined {
		return this.blame?.();
	}
}

export class GitAuthorsCodeLens extends CodeLens {
	constructor(
		public readonly languageId: string,
		public readonly symbol: DocumentSymbol | SymbolInformation,
		public readonly uri: GitUri | undefined,
		private readonly blame: () => GitBlameLines | undefined,
		public readonly blameRange: Range,
		public readonly isFullRange: boolean,
		range: Range,
		public readonly desiredCommand: CodeLensCommand | false,
	) {
		super(range);
	}

	getBlame(): GitBlameLines | undefined {
		return this.blame();
	}
}

export class GitCodeLensProvider implements CodeLensProvider {
	static selector: DocumentSelector = [
		{ scheme: DocumentSchemes.File },
		{ scheme: DocumentSchemes.Git },
		{ scheme: DocumentSchemes.GitLens },
		{ scheme: DocumentSchemes.PRs },
		{ scheme: DocumentSchemes.Vsls },
	];

	private _onDidChangeCodeLenses = new EventEmitter<void>();
	get onDidChangeCodeLenses(): Event<void> {
		return this._onDidChangeCodeLenses.event;
	}

	constructor(private readonly container: Container) {}

	reset(_reason?: 'idle' | 'saved') {
		this._onDidChangeCodeLenses.fire();
	}

	async provideCodeLenses(document: TextDocument, token: CancellationToken): Promise<CodeLens[]> {
		const trackedDocument = await this.container.tracker.getOrAdd(document);
		if (!trackedDocument.isBlameable) return [];

		let dirty = false;
		if (document.isDirty) {
			// Only allow dirty blames if we are idle
			if (trackedDocument.isDirtyIdle) {
				const maxLines = this.container.config.advanced.blame.sizeThresholdAfterEdit;
				if (maxLines > 0 && document.lineCount > maxLines) {
					dirty = true;
				}
			} else {
				dirty = true;
			}
		}

		const cfg = configuration.get('codeLens', document);

		let languageScope = cfg.scopesByLanguage?.find(ll => ll.language?.toLowerCase() === document.languageId);
		if (languageScope == null) {
			languageScope = {
				language: document.languageId,
			};
		}
		if (languageScope.scopes == null) {
			languageScope.scopes = cfg.scopes;
		}
		if (languageScope.symbolScopes == null) {
			languageScope.symbolScopes = cfg.symbolScopes;
		}

		languageScope.symbolScopes =
			languageScope.symbolScopes != null
				? (languageScope.symbolScopes = languageScope.symbolScopes.map(s => s.toLowerCase()))
				: [];

		const lenses: CodeLens[] = [];

		const gitUri = trackedDocument.uri;
		let blame: GitBlame | undefined;
		let symbols;

		if (!dirty) {
			if (token.isCancellationRequested) return lenses;

			if (languageScope.scopes.length === 1 && languageScope.scopes.includes(CodeLensScopes.Document)) {
				blame = document.isDirty
					? await this.container.git.getBlameForFileContents(gitUri, document.getText())
					: await this.container.git.getBlameForFile(gitUri);
			} else {
				[blame, symbols] = await Promise.all([
					document.isDirty
						? this.container.git.getBlameForFileContents(gitUri, document.getText())
						: this.container.git.getBlameForFile(gitUri),
					commands.executeCommand(BuiltInCommands.ExecuteDocumentSymbolProvider, document.uri) as Promise<
						SymbolInformation[]
					>,
				]);
			}

			if (blame === undefined || blame.lines.length === 0) return lenses;
		} else if (languageScope.scopes.length !== 1 || !languageScope.scopes.includes(CodeLensScopes.Document)) {
			symbols = (await commands.executeCommand(
				BuiltInCommands.ExecuteDocumentSymbolProvider,
				document.uri,
			)) as SymbolInformation[];
		}

		if (token.isCancellationRequested) return lenses;

		const documentRangeFn = Functions.once(() => document.validateRange(new Range(0, 0, 1000000, 1000000)));

		// Since blame information isn't valid when there are unsaved changes -- update the lenses appropriately
		const dirtyCommand: Command | undefined = dirty
			? { command: undefined!, title: this.getDirtyTitle(cfg) }
			: undefined;

		if (symbols !== undefined) {
			Logger.log('GitCodeLensProvider.provideCodeLenses:', `${symbols.length} symbol(s) found`);
			for (const sym of symbols) {
				this.provideCodeLens(
					lenses,
					document,
					sym,
					languageScope as Required<CodeLensLanguageScope>,
					documentRangeFn,
					blame,
					gitUri,
					cfg,
					dirty,
					dirtyCommand,
				);
			}
		}

		if (
			(languageScope.scopes.includes(CodeLensScopes.Document) || languageScope.symbolScopes.includes('file')) &&
			!languageScope.symbolScopes.includes('!file')
		) {
			// Check if we have a lens for the whole document -- if not add one
			if (lenses.find(l => l.range.start.line === 0 && l.range.end.line === 0) == null) {
				const blameRange = documentRangeFn();

				let blameForRangeFn: (() => GitBlameLines | undefined) | undefined = undefined;
				if (dirty || cfg.recentChange.enabled) {
					if (!dirty) {
						blameForRangeFn = Functions.once(() =>
							this.container.git.getBlameForRangeSync(blame!, gitUri, blameRange),
						);
					}

					const fileSymbol = new SymbolInformation(
						gitUri.fileName,
						SymbolKind.File,
						'',
						new Location(gitUri.documentUri(), new Range(0, 0, 0, blameRange.start.character)),
					);
					lenses.push(
						new GitRecentChangeCodeLens(
							document.languageId,
							fileSymbol,
							gitUri,
							blameForRangeFn,
							blameRange,
							true,
							getRangeFromSymbol(fileSymbol),
							cfg.recentChange.command,
							dirtyCommand,
						),
					);
				}
				if (!dirty && cfg.authors.enabled) {
					if (blameForRangeFn === undefined) {
						blameForRangeFn = Functions.once(() =>
							this.container.git.getBlameForRangeSync(blame!, gitUri, blameRange),
						);
					}

					const fileSymbol = new SymbolInformation(
						gitUri.fileName,
						SymbolKind.File,
						'',
						new Location(gitUri.documentUri(), new Range(0, 1, 0, blameRange.start.character)),
					);
					lenses.push(
						new GitAuthorsCodeLens(
							document.languageId,
							fileSymbol,
							gitUri,
							blameForRangeFn,
							blameRange,
							true,
							getRangeFromSymbol(fileSymbol),
							cfg.authors.command,
						),
					);
				}
			}
		}

		return lenses;
	}

	private getValidateSymbolRange(
		symbol: SymbolInformation | DocumentSymbol,
		languageScope: Required<CodeLensLanguageScope>,
		documentRangeFn: () => Range,
		includeSingleLineSymbols: boolean,
	): Range | undefined {
		let valid = false;
		let range: Range | undefined;

		const symbolName = SymbolKind[symbol.kind].toLowerCase();
		switch (symbol.kind) {
			case SymbolKind.File:
				if (
					languageScope.scopes.includes(CodeLensScopes.Containers) ||
					languageScope.symbolScopes.includes(symbolName)
				) {
					valid = !languageScope.symbolScopes.includes(`!${symbolName}`);
				}

				if (valid) {
					// Adjust the range to be for the whole file
					range = documentRangeFn();
				}
				break;

			case SymbolKind.Package:
				if (
					languageScope.scopes.includes(CodeLensScopes.Containers) ||
					languageScope.symbolScopes.includes(symbolName)
				) {
					valid = !languageScope.symbolScopes.includes(`!${symbolName}`);
				}

				if (valid) {
					// Adjust the range to be for the whole file
					range = getRangeFromSymbol(symbol);
					if (range.start.line === 0 && range.end.line === 0) {
						range = documentRangeFn();
					}
				}
				break;

			case SymbolKind.Class:
			case SymbolKind.Interface:
			case SymbolKind.Module:
			case SymbolKind.Namespace:
			case SymbolKind.Struct:
				if (
					languageScope.scopes.includes(CodeLensScopes.Containers) ||
					languageScope.symbolScopes.includes(symbolName)
				) {
					range = getRangeFromSymbol(symbol);
					valid =
						!languageScope.symbolScopes.includes(`!${symbolName}`) &&
						(includeSingleLineSymbols || !range.isSingleLine);
				}
				break;

			case SymbolKind.Constructor:
			case SymbolKind.Enum:
			case SymbolKind.Function:
			case SymbolKind.Method:
			case SymbolKind.Property:
				if (
					languageScope.scopes.includes(CodeLensScopes.Blocks) ||
					languageScope.symbolScopes.includes(symbolName)
				) {
					range = getRangeFromSymbol(symbol);
					valid =
						!languageScope.symbolScopes.includes(`!${symbolName}`) &&
						(includeSingleLineSymbols || !range.isSingleLine);
				}
				break;

			case SymbolKind.String:
				if (
					languageScope.symbolScopes.includes(symbolName) ||
					// A special case for markdown files, SymbolKind.String seems to be returned for headers, so consider those containers
					(languageScope.language === 'markdown' && languageScope.scopes.includes(CodeLensScopes.Containers))
				) {
					range = getRangeFromSymbol(symbol);
					valid =
						!languageScope.symbolScopes.includes(`!${symbolName}`) &&
						(includeSingleLineSymbols || !range.isSingleLine);
				}
				break;

			default:
				if (languageScope.symbolScopes.includes(symbolName)) {
					range = getRangeFromSymbol(symbol);
					valid =
						!languageScope.symbolScopes.includes(`!${symbolName}`) &&
						(includeSingleLineSymbols || !range.isSingleLine);
				}
				break;
		}

		return valid ? range ?? getRangeFromSymbol(symbol) : undefined;
	}

	private provideCodeLens(
		lenses: CodeLens[],
		document: TextDocument,
		symbol: SymbolInformation | DocumentSymbol,
		languageScope: Required<CodeLensLanguageScope>,
		documentRangeFn: () => Range,
		blame: GitBlame | undefined,
		gitUri: GitUri | undefined,
		cfg: CodeLensConfig,
		dirty: boolean,
		dirtyCommand: Command | undefined,
	): void {
		try {
			const blameRange = this.getValidateSymbolRange(
				symbol,
				languageScope,
				documentRangeFn,
				cfg.includeSingleLineSymbols,
			);
			if (blameRange === undefined) return;

			const line = document.lineAt(getRangeFromSymbol(symbol).start);
			// Make sure there is only 1 lens per line
			if (lenses.length && lenses[lenses.length - 1].range.start.line === line.lineNumber) return;

			// Anchor the code lens to the start of the line -- so that the range won't change with edits (otherwise the code lens will be removed and re-added)
			let startChar = 0;

			let blameForRangeFn: (() => GitBlameLines | undefined) | undefined;
			if (dirty || cfg.recentChange.enabled) {
				if (!dirty) {
					blameForRangeFn = Functions.once(() =>
						this.container.git.getBlameForRangeSync(blame!, gitUri!, blameRange),
					);
				}
				lenses.push(
					new GitRecentChangeCodeLens(
						document.languageId,
						symbol,
						gitUri,
						blameForRangeFn,
						blameRange,
						false,
						line.range.with(new Position(line.range.start.line, startChar)),
						cfg.recentChange.command,
						dirtyCommand,
					),
				);
				startChar++;
			}

			if (cfg.authors.enabled) {
				let multiline = !blameRange.isSingleLine;
				// HACK for Omnisharp, since it doesn't return full ranges
				if (!multiline && document.languageId === 'csharp') {
					switch (symbol.kind) {
						case SymbolKind.File:
							break;
						case SymbolKind.Package:
						case SymbolKind.Module:
						case SymbolKind.Namespace:
						case SymbolKind.Class:
						case SymbolKind.Interface:
						case SymbolKind.Constructor:
						case SymbolKind.Method:
						case SymbolKind.Function:
						case SymbolKind.Enum:
							multiline = true;
							break;
					}
				}

				if (multiline && !dirty) {
					if (blameForRangeFn === undefined) {
						blameForRangeFn = Functions.once(() =>
							this.container.git.getBlameForRangeSync(blame!, gitUri!, blameRange),
						);
					}
					lenses.push(
						new GitAuthorsCodeLens(
							document.languageId,
							symbol,
							gitUri,
							blameForRangeFn,
							blameRange,
							false,
							line.range.with(new Position(line.range.start.line, startChar)),
							cfg.authors.command,
						),
					);
				}
			}
		} finally {
			if (isDocumentSymbol(symbol)) {
				for (const child of symbol.children) {
					this.provideCodeLens(
						lenses,
						document,
						child,
						languageScope,
						documentRangeFn,
						blame,
						gitUri,
						cfg,
						dirty,
						dirtyCommand,
					);
				}
			}
		}
	}

	resolveCodeLens(lens: CodeLens, token: CancellationToken): CodeLens | Promise<CodeLens> {
		if (lens instanceof GitRecentChangeCodeLens) return this.resolveGitRecentChangeCodeLens(lens, token);
		if (lens instanceof GitAuthorsCodeLens) return this.resolveGitAuthorsCodeLens(lens, token);
		return Promise.reject<CodeLens>(undefined);
	}

	private resolveGitRecentChangeCodeLens(lens: GitRecentChangeCodeLens, _token: CancellationToken): CodeLens {
		const blame = lens.getBlame();
		if (blame === undefined) return lens;

		const recentCommit: GitCommit = Iterables.first(blame.commits.values());
		// TODO@eamodio This is FAR too expensive, but this accounts for commits that delete lines -- is there another way?
		// if (lens.uri != null) {
		// 	const commit = await this.container.git.getCommitForFile(lens.uri.repoPath, lens.uri.fsPath, {
		// 		range: lens.blameRange,
		// 	});
		// 	if (
		// 		commit != null &&
		// 		commit.sha !== recentCommit.sha &&
		// 		commit.date.getTime() > recentCommit.date.getTime()
		// 	) {
		// 		recentCommit = commit;
		// 	}
		// }

		let title = `${recentCommit.author}, ${recentCommit.formattedDate}`;
		if (this.container.config.debug) {
			title += ` [${lens.languageId}: ${SymbolKind[lens.symbol.kind]}(${lens.range.start.character}-${
				lens.range.end.character
			}${
				(lens.symbol as SymbolInformation).containerName
					? `|${(lens.symbol as SymbolInformation).containerName}`
					: ''
			}), Lines (${lens.blameRange.start.line + 1}-${lens.blameRange.end.line + 1}), Commit (${
				recentCommit.shortSha
			})]`;
		}

		if (lens.desiredCommand === false) {
			return this.applyCommandWithNoClickAction(title, lens);
		}

		switch (lens.desiredCommand) {
			case CodeLensCommand.CopyRemoteCommitUrl:
				return this.applyCopyOrOpenCommitOnRemoteCommand<GitRecentChangeCodeLens>(
					title,
					lens,
					recentCommit,
					true,
				);
			case CodeLensCommand.CopyRemoteFileUrl:
				return this.applyCopyOrOpenFileOnRemoteCommand<GitRecentChangeCodeLens>(
					title,
					lens,
					recentCommit,
					true,
				);
			case CodeLensCommand.DiffWithPrevious:
				return this.applyDiffWithPreviousCommand<GitRecentChangeCodeLens>(title, lens, recentCommit);
			case CodeLensCommand.OpenCommitOnRemote:
				return this.applyCopyOrOpenCommitOnRemoteCommand<GitRecentChangeCodeLens>(title, lens, recentCommit);
			case CodeLensCommand.OpenFileOnRemote:
				return this.applyCopyOrOpenFileOnRemoteCommand<GitRecentChangeCodeLens>(title, lens, recentCommit);
			case CodeLensCommand.RevealCommitInView:
				return this.applyRevealCommitInViewCommand<GitRecentChangeCodeLens>(title, lens, recentCommit);
			case CodeLensCommand.ShowCommitsInView:
				return this.applyShowCommitsInViewCommand<GitRecentChangeCodeLens>(title, lens, blame, recentCommit);
			case CodeLensCommand.ShowQuickCommitDetails:
				return this.applyShowQuickCommitDetailsCommand<GitRecentChangeCodeLens>(title, lens, recentCommit);
			case CodeLensCommand.ShowQuickCommitFileDetails:
				return this.applyShowQuickCommitFileDetailsCommand<GitRecentChangeCodeLens>(title, lens, recentCommit);
			case CodeLensCommand.ShowQuickCurrentBranchHistory:
				return this.applyShowQuickCurrentBranchHistoryCommand<GitRecentChangeCodeLens>(title, lens);
			case CodeLensCommand.ShowQuickFileHistory:
				return this.applyShowQuickFileHistoryCommand<GitRecentChangeCodeLens>(title, lens);
			case CodeLensCommand.ToggleFileBlame:
				return this.applyToggleFileBlameCommand<GitRecentChangeCodeLens>(title, lens);
			case CodeLensCommand.ToggleFileChanges:
				return this.applyToggleFileChangesCommand<GitRecentChangeCodeLens>(title, lens, recentCommit);
			case CodeLensCommand.ToggleFileChangesOnly:
				return this.applyToggleFileChangesCommand<GitRecentChangeCodeLens>(title, lens, recentCommit, true);
			case CodeLensCommand.ToggleFileHeatmap:
				return this.applyToggleFileHeatmapCommand<GitRecentChangeCodeLens>(title, lens);
			default:
				return lens;
		}
	}

	private resolveGitAuthorsCodeLens(lens: GitAuthorsCodeLens, _token: CancellationToken): CodeLens {
		const blame = lens.getBlame();
		if (blame === undefined) return lens;

		const count = blame.authors.size;

		const author = Iterables.first(blame.authors.values()).name;

		let title = `${count} ${count > 1 ? 'authors' : 'author'} (${author}${count > 1 ? ' and others' : ''})`;
		if (this.container.config.debug) {
			title += ` [${lens.languageId}: ${SymbolKind[lens.symbol.kind]}(${lens.range.start.character}-${
				lens.range.end.character
			}${
				(lens.symbol as SymbolInformation).containerName
					? `|${(lens.symbol as SymbolInformation).containerName}`
					: ''
			}), Lines (${lens.blameRange.start.line + 1}-${lens.blameRange.end.line + 1}), Authors (${Iterables.join(
				Iterables.map(blame.authors.values(), a => a.name),
				', ',
			)})]`;
		}

		if (lens.desiredCommand === false) {
			return this.applyCommandWithNoClickAction(title, lens);
		}

		const commit =
			Iterables.find(blame.commits.values(), c => c.author === author) ?? Iterables.first(blame.commits.values());

		switch (lens.desiredCommand) {
			case CodeLensCommand.CopyRemoteCommitUrl:
				return this.applyCopyOrOpenCommitOnRemoteCommand<GitAuthorsCodeLens>(title, lens, commit, true);
			case CodeLensCommand.CopyRemoteFileUrl:
				return this.applyCopyOrOpenFileOnRemoteCommand<GitAuthorsCodeLens>(title, lens, commit, true);
			case CodeLensCommand.DiffWithPrevious:
				return this.applyDiffWithPreviousCommand<GitAuthorsCodeLens>(title, lens, commit);
			case CodeLensCommand.OpenCommitOnRemote:
				return this.applyCopyOrOpenCommitOnRemoteCommand<GitAuthorsCodeLens>(title, lens, commit);
			case CodeLensCommand.OpenFileOnRemote:
				return this.applyCopyOrOpenFileOnRemoteCommand<GitAuthorsCodeLens>(title, lens, commit);
			case CodeLensCommand.RevealCommitInView:
				return this.applyRevealCommitInViewCommand<GitAuthorsCodeLens>(title, lens, commit);
			case CodeLensCommand.ShowCommitsInView:
				return this.applyShowCommitsInViewCommand<GitAuthorsCodeLens>(title, lens, blame);
			case CodeLensCommand.ShowQuickCommitDetails:
				return this.applyShowQuickCommitDetailsCommand<GitAuthorsCodeLens>(title, lens, commit);
			case CodeLensCommand.ShowQuickCommitFileDetails:
				return this.applyShowQuickCommitFileDetailsCommand<GitAuthorsCodeLens>(title, lens, commit);
			case CodeLensCommand.ShowQuickCurrentBranchHistory:
				return this.applyShowQuickCurrentBranchHistoryCommand<GitAuthorsCodeLens>(title, lens);
			case CodeLensCommand.ShowQuickFileHistory:
				return this.applyShowQuickFileHistoryCommand<GitAuthorsCodeLens>(title, lens);
			case CodeLensCommand.ToggleFileBlame:
				return this.applyToggleFileBlameCommand<GitAuthorsCodeLens>(title, lens);
			case CodeLensCommand.ToggleFileChanges:
				return this.applyToggleFileChangesCommand<GitAuthorsCodeLens>(title, lens, commit);
			case CodeLensCommand.ToggleFileChangesOnly:
				return this.applyToggleFileChangesCommand<GitAuthorsCodeLens>(title, lens, commit, true);
			case CodeLensCommand.ToggleFileHeatmap:
				return this.applyToggleFileHeatmapCommand<GitAuthorsCodeLens>(title, lens);
			default:
				return lens;
		}
	}

	private applyDiffWithPreviousCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
		title: string,
		lens: T,
		commit: GitCommit | undefined,
	): T {
		lens.command = command<[undefined, DiffWithPreviousCommandArgs]>({
			title: title,
			command: Commands.DiffWithPrevious,
			arguments: [
				undefined,
				{
					commit: commit,
					uri: lens.uri!.toFileUri(),
				},
			],
		});
		return lens;
	}

	private applyCopyOrOpenCommitOnRemoteCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
		title: string,
		lens: T,
		commit: GitCommit,
		clipboard: boolean = false,
	): T {
		lens.command = command<[OpenOnRemoteCommandArgs]>({
			title: title,
			command: Commands.OpenOnRemote,
			arguments: [
				{
					resource: {
						type: RemoteResourceType.Commit,
						sha: commit.sha,
					},
					repoPath: commit.repoPath,
					clipboard: clipboard,
				},
			],
		});
		return lens;
	}

	private applyCopyOrOpenFileOnRemoteCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
		title: string,
		lens: T,
		commit: GitCommit,
		clipboard: boolean = false,
	): T {
		lens.command = command<[OpenOnRemoteCommandArgs]>({
			title: title,
			command: Commands.OpenOnRemote,
			arguments: [
				{
					resource: {
						type: RemoteResourceType.Revision,
						fileName: commit.fileName,
						sha: commit.sha,
					},
					repoPath: commit.repoPath,
					clipboard: clipboard,
				},
			],
		});
		return lens;
	}

	private applyRevealCommitInViewCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
		title: string,
		lens: T,
		commit: GitCommit | undefined,
	): T {
		lens.command = command<[Uri, ShowQuickCommitCommandArgs]>({
			title: title,
			command: commit?.isUncommitted ? '' : CodeLensCommand.RevealCommitInView,
			arguments: [
				lens.uri!.toFileUri(),
				{
					commit: commit,
					sha: commit === undefined ? undefined : commit.sha,
				},
			],
		});
		return lens;
	}

	private applyShowCommitsInViewCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
		title: string,
		lens: T,
		blame: GitBlameLines,
		commit?: GitCommit,
	): T {
		let refs;
		if (commit === undefined) {
			refs = [...Iterables.filterMap(blame.commits.values(), c => (c.isUncommitted ? undefined : c.ref))];
		} else {
			refs = [commit.ref];
		}

		lens.command = command<[ShowCommitsInViewCommandArgs]>({
			title: title,
			command: refs.length === 0 ? '' : Commands.ShowCommitsInView,
			arguments: [
				{
					repoPath: blame.repoPath,
					refs: refs,
				},
			],
		});
		return lens;
	}

	private applyShowQuickCommitDetailsCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
		title: string,
		lens: T,
		commit: GitCommit | undefined,
	): T {
		lens.command = command<[Uri, ShowQuickCommitCommandArgs]>({
			title: title,
			command: commit?.isUncommitted ? '' : CodeLensCommand.ShowQuickCommitDetails,
			arguments: [
				lens.uri!.toFileUri(),
				{
					commit: commit,
					sha: commit === undefined ? undefined : commit.sha,
				},
			],
		});
		return lens;
	}

	private applyShowQuickCommitFileDetailsCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
		title: string,
		lens: T,
		commit: GitCommit | undefined,
	): T {
		lens.command = command<[Uri, ShowQuickCommitFileCommandArgs]>({
			title: title,
			command: commit?.isUncommitted ? '' : CodeLensCommand.ShowQuickCommitFileDetails,
			arguments: [
				lens.uri!.toFileUri(),
				{
					commit: commit,
					sha: commit === undefined ? undefined : commit.sha,
				},
			],
		});
		return lens;
	}

	private applyShowQuickCurrentBranchHistoryCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
		title: string,
		lens: T,
	): T {
		lens.command = command<[Uri]>({
			title: title,
			command: CodeLensCommand.ShowQuickCurrentBranchHistory,
			arguments: [lens.uri!.toFileUri()],
		});
		return lens;
	}

	private applyShowQuickFileHistoryCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
		title: string,
		lens: T,
	): T {
		lens.command = command<[Uri, ShowQuickFileHistoryCommandArgs]>({
			title: title,
			command: CodeLensCommand.ShowQuickFileHistory,
			arguments: [
				lens.uri!.toFileUri(),
				{
					range: lens.isFullRange ? undefined : lens.blameRange,
				},
			],
		});
		return lens;
	}

	private applyToggleFileBlameCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
		title: string,
		lens: T,
	): T {
		lens.command = command<[Uri]>({
			title: title,
			command: Commands.ToggleFileBlame,
			arguments: [lens.uri!.toFileUri()],
		});
		return lens;
	}

	private applyToggleFileChangesCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
		title: string,
		lens: T,
		commit: GitCommit,
		only?: boolean,
	): T {
		lens.command = command<[Uri, ToggleFileChangesAnnotationCommandArgs]>({
			title: title,
			command: Commands.ToggleFileChanges,
			arguments: [
				lens.uri!.toFileUri(),
				{
					type: FileAnnotationType.Changes,
					context: { sha: commit.sha, only: only, selection: false },
				},
			],
		});
		return lens;
	}

	private applyToggleFileHeatmapCommand<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
		title: string,
		lens: T,
	): T {
		lens.command = command<[Uri]>({
			title: title,
			command: Commands.ToggleFileHeatmap,
			arguments: [lens.uri!.toFileUri()],
		});
		return lens;
	}

	private applyCommandWithNoClickAction<T extends GitRecentChangeCodeLens | GitAuthorsCodeLens>(
		title: string,
		lens: T,
	): T {
		lens.command = {
			title: title,
			command: '',
		};
		return lens;
	}

	private getDirtyTitle(cfg: CodeLensConfig) {
		if (cfg.recentChange.enabled && cfg.authors.enabled) {
			return this.container.config.strings.codeLens.unsavedChanges.recentChangeAndAuthors;
		}
		if (cfg.recentChange.enabled) return this.container.config.strings.codeLens.unsavedChanges.recentChangeOnly;
		return this.container.config.strings.codeLens.unsavedChanges.authorsOnly;
	}
}

function getRangeFromSymbol(symbol: DocumentSymbol | SymbolInformation) {
	return isDocumentSymbol(symbol) ? symbol.range : symbol.location.range;
}

function isDocumentSymbol(symbol: DocumentSymbol | SymbolInformation): symbol is DocumentSymbol {
	return Functions.is<DocumentSymbol>(symbol, 'children');
}
