'use strict';
import { CancellationTokenSource, Disposable, QuickPick, window } from 'vscode';
import { GitActions } from '../commands';
import { getBranchesAndOrTags, getValidateGitReferenceFn, QuickCommandButtons } from '../commands/quickCommand';
import { GlyphChars } from '../constants';
import { Container } from '../container';
import { BranchSortOptions, GitBranch, GitReference, GitTag, TagSortOptions } from '../git/git';
import { KeyboardScope, Keys } from '../keyboard';
import { BranchQuickPickItem, getQuickPickIgnoreFocusOut, RefQuickPickItem, TagQuickPickItem } from '../quickpicks';

export type ReferencesQuickPickItem = BranchQuickPickItem | TagQuickPickItem | RefQuickPickItem;

export enum ReferencesQuickPickIncludes {
	Branches = 1,
	Tags = 2,
	WorkingTree = 4,
	HEAD = 8,

	BranchesAndTags = 3,
}

export interface ReferencesQuickPickOptions {
	allowEnteringRefs?: boolean | { ranges?: boolean };
	autoPick?: boolean;
	picked?: string;
	filter?: { branches?(b: GitBranch): boolean; tags?(t: GitTag): boolean };
	include?: ReferencesQuickPickIncludes;
	keys?: Keys[];
	onDidPressKey?(key: Keys, quickpick: QuickPick<ReferencesQuickPickItem>): void | Promise<void>;
	sort?: boolean | { branches?: BranchSortOptions; tags?: TagSortOptions };
}

export namespace ReferencePicker {
	export async function show(
		repoPath: string,
		title: string,
		placeHolder: string,
		options: ReferencesQuickPickOptions = {},
	): Promise<GitReference | undefined> {
		const quickpick = window.createQuickPick<ReferencesQuickPickItem>();
		(quickpick as any).enableProposedApi = true;
		quickpick.ignoreFocusOut = getQuickPickIgnoreFocusOut();

		quickpick.title = title;
		quickpick.placeholder =
			options.allowEnteringRefs != null
				? `${placeHolder}${GlyphChars.Space.repeat(3)}(or enter a reference using #)`
				: placeHolder;
		quickpick.matchOnDescription = true;

		const disposables: Disposable[] = [];

		let scope: KeyboardScope | undefined;
		if (options?.keys != null && options.keys.length !== 0 && options?.onDidPressKey !== null) {
			scope = Container.instance.keyboard.createScope(
				Object.fromEntries(
					options.keys.map(key => [
						key,
						{
							onDidPressKey: key => {
								if (quickpick.activeItems.length !== 0) {
									void options.onDidPressKey!(key, quickpick);
								}
							},
						},
					]),
				),
			);
			void scope.start();
			disposables.push(scope);
		}

		const cancellation = new CancellationTokenSource();

		let autoPick;
		let items = getItems(repoPath, options);
		if (options.autoPick) {
			items = items.then(itms => {
				if (itms.length <= 1) {
					autoPick = itms[0];
					cancellation.cancel();
				}
				return itms;
			});
		}

		quickpick.busy = true;
		quickpick.enabled = false;

		quickpick.show();

		const getValidateGitReference = getValidateGitReferenceFn(
			(await Container.instance.git.getRepository(repoPath))!,
			{
				buttons: [QuickCommandButtons.RevealInSideBar],
				ranges:
					// eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
					options?.allowEnteringRefs && typeof options.allowEnteringRefs !== 'boolean'
						? options.allowEnteringRefs.ranges
						: undefined,
			},
		);

		quickpick.items = await items;

		quickpick.busy = false;
		quickpick.enabled = true;

		try {
			let pick = await new Promise<ReferencesQuickPickItem | undefined>(resolve => {
				disposables.push(
					cancellation.token.onCancellationRequested(() => quickpick.hide()),
					quickpick.onDidHide(() => resolve(undefined)),
					quickpick.onDidAccept(() => {
						if (quickpick.activeItems.length === 0) return;

						resolve(quickpick.activeItems[0]);
					}),
					quickpick.onDidChangeValue(async e => {
						// eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
						if (options.allowEnteringRefs) {
							if (!(await getValidateGitReference(quickpick, e))) {
								quickpick.items = await items;
							}
						}

						if (scope == null) return;

						// Pause the left/right keyboard commands if there is a value, otherwise the left/right arrows won't work in the input properly
						if (e.length !== 0) {
							await scope.pause(['left', 'right']);
						} else {
							await scope.resume();
						}
					}),
					quickpick.onDidTriggerItemButton(({ button, item: { item } }) => {
						if (button === QuickCommandButtons.RevealInSideBar) {
							if (GitReference.isBranch(item)) {
								void GitActions.Branch.reveal(item, { select: true, expand: true });
							} else if (GitReference.isTag(item)) {
								void GitActions.Tag.reveal(item, { select: true, expand: true });
							} else if (GitReference.isRevision(item)) {
								void GitActions.Commit.reveal(item, { select: true, expand: true });
							}
						}
					}),
				);
			});
			if (pick == null && autoPick != null) {
				pick = autoPick;
			}
			if (pick == null) return undefined;

			return pick.item;
		} finally {
			quickpick.dispose();
			disposables.forEach(d => d.dispose());
		}
	}

	async function getItems(
		repoPath: string,
		{ picked, filter, include, sort }: ReferencesQuickPickOptions,
	): Promise<ReferencesQuickPickItem[]> {
		include = include ?? ReferencesQuickPickIncludes.BranchesAndTags;

		const items: ReferencesQuickPickItem[] = await getBranchesAndOrTags(
			(await Container.instance.git.getRepository(repoPath))!,
			include && ReferencesQuickPickIncludes.BranchesAndTags
				? ['branches', 'tags']
				: include && ReferencesQuickPickIncludes.Branches
				? ['branches']
				: include && ReferencesQuickPickIncludes.Tags
				? ['tags']
				: [],
			{
				buttons: [QuickCommandButtons.RevealInSideBar],
				filter: filter,
				picked: picked,
				sort: sort ?? { branches: { current: false }, tags: {} },
			},
		);

		// Move the picked item to the top
		if (picked) {
			const index = items.findIndex(i => i.ref === picked);
			if (index !== -1) {
				items.splice(0, 0, ...items.splice(index, 1));
			}
		}

		if (include & ReferencesQuickPickIncludes.HEAD) {
			items.splice(0, 0, RefQuickPickItem.create('HEAD', repoPath, undefined, { icon: true }));
		}

		if (include & ReferencesQuickPickIncludes.WorkingTree) {
			items.splice(0, 0, RefQuickPickItem.create('', repoPath, undefined, { icon: true }));
		}

		return items;
	}
}
