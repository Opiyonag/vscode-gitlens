'use strict';
import { Container } from '../../container';
import { GitBranch, GitLog, GitReference, GitRevisionReference, Repository } from '../../git/git';
import { FlagsQuickPickItem } from '../../quickpicks';
import {
	appendReposToTitle,
	PartialStepState,
	pickCommitsStep,
	pickRepositoryStep,
	QuickCommand,
	QuickPickStep,
	StepGenerator,
	StepResult,
	StepResultGenerator,
	StepSelection,
	StepState,
} from '../quickCommand';

interface Context {
	repos: Repository[];
	cache: Map<string, Promise<GitLog | undefined>>;
	destination: GitBranch;
	title: string;
}

type Flags = '--edit' | '--no-edit';

interface State<Refs = GitRevisionReference | GitRevisionReference[]> {
	repo: string | Repository;
	references: Refs;
	flags: Flags[];
}

export interface RevertGitCommandArgs {
	readonly command: 'revert';
	state?: Partial<State>;
}

type RevertStepState<T extends State = State> = ExcludeSome<StepState<T>, 'repo', string>;

export class RevertGitCommand extends QuickCommand<State> {
	constructor(args?: RevertGitCommandArgs) {
		super('revert', 'revert', 'Revert', {
			description: 'undoes the changes of specified commits, by creating new commits with inverted changes',
		});

		let counter = 0;
		if (args?.state?.repo != null) {
			counter++;
		}

		if (
			args?.state?.references != null &&
			(!Array.isArray(args.state.references) || args.state.references.length !== 0)
		) {
			counter++;
		}

		this.initialState = {
			counter: counter,
			confirm: true,
			...args?.state,
		};
	}

	override get canSkipConfirm(): boolean {
		return false;
	}

	execute(state: RevertStepState<State<GitRevisionReference[]>>) {
		return state.repo.revert(...state.flags, ...state.references.map(c => c.ref).reverse());
	}

	protected async *steps(state: PartialStepState<State>): StepGenerator {
		const context: Context = {
			repos: [...(await Container.instance.git.getOrderedRepositories())],
			cache: new Map<string, Promise<GitLog | undefined>>(),
			destination: undefined!,
			title: this.title,
		};

		if (state.flags == null) {
			state.flags = [];
		}

		if (state.references != null && !Array.isArray(state.references)) {
			state.references = [state.references];
		}

		let skippedStepOne = false;

		while (this.canStepsContinue(state)) {
			context.title = this.title;

			if (state.counter < 1 || state.repo == null || typeof state.repo === 'string') {
				skippedStepOne = false;
				if (context.repos.length === 1) {
					skippedStepOne = true;
					if (state.repo == null) {
						state.counter++;
					}

					state.repo = context.repos[0];
				} else {
					const result = yield* pickRepositoryStep(state, context);
					// Always break on the first step (so we will go back)
					if (result === StepResult.Break) break;

					state.repo = result;
				}
			}

			if (context.destination == null) {
				const branch = await state.repo.getBranch();
				if (branch == null) break;

				context.destination = branch;
			}

			if (state.counter < 2 || state.references == null || state.references.length === 0) {
				const ref = context.destination.ref;

				let log = context.cache.get(ref);
				if (log == null) {
					log = Container.instance.git.getLog(state.repo.path, { ref: ref, merges: false });
					context.cache.set(ref, log);
				}

				const result: StepResult<GitRevisionReference[]> = yield* pickCommitsStep(
					state as RevertStepState,
					context,
					{
						log: await log,
						onDidLoadMore: log => context.cache.set(ref, Promise.resolve(log)),
						placeholder: (context, log) =>
							log == null ? `${context.destination.name} has no commits` : 'Choose commits to revert',
						picked: state.references?.map(r => r.ref),
					},
				);
				if (result === StepResult.Break) {
					// If we skipped the previous step, make sure we back up past it
					if (skippedStepOne) {
						state.counter--;
					}

					continue;
				}

				state.references = result;
			}

			const result = yield* this.confirmStep(state as RevertStepState, context);
			if (result === StepResult.Break) continue;

			state.flags = result;

			QuickCommand.endSteps(state);
			this.execute(state as RevertStepState<State<GitRevisionReference[]>>);
		}

		return state.counter < 0 ? StepResult.Break : undefined;
	}

	private *confirmStep(state: RevertStepState, context: Context): StepResultGenerator<Flags[]> {
		const step: QuickPickStep<FlagsQuickPickItem<Flags>> = this.createConfirmStep(
			appendReposToTitle(`Confirm ${context.title}`, state, context),
			[
				FlagsQuickPickItem.create<Flags>(state.flags, ['--no-edit'], {
					label: this.title,
					description: '--no-edit',
					detail: `Will revert ${GitReference.toString(state.references)}`,
				}),
				FlagsQuickPickItem.create<Flags>(state.flags, ['--edit'], {
					label: `${this.title} & Edit`,
					description: '--edit',
					detail: `Will revert and edit ${GitReference.toString(state.references)}`,
				}),
			],
		);
		const selection: StepSelection<typeof step> = yield step;
		return QuickCommand.canPickStepContinue(step, state, selection) ? selection[0].item : StepResult.Break;
	}
}
