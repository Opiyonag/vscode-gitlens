'use strict';
import { Container } from '../container';
import { GitRemote, RemoteProvider, RemoteResource, RemoteResourceType } from '../git/git';
import { Command, command, Commands, executeCommand } from './common';
import { OpenOnRemoteCommandArgs } from './openOnRemote';

export interface CreatePullRequestOnRemoteCommandArgs {
	base?: string;
	compare: string;
	remote: string;
	repoPath: string;

	clipboard?: boolean;
}

@command()
export class CreatePullRequestOnRemoteCommand extends Command {
	constructor() {
		super(Commands.CreatePullRequestOnRemote);
	}

	async execute(args?: CreatePullRequestOnRemoteCommandArgs) {
		if (args?.repoPath == null) return;

		const repo = await Container.instance.git.getRepository(args.repoPath);
		if (repo == null) return;

		const compareRemote = await repo.getRemote(args.remote);
		if (compareRemote?.provider == null) return;

		const providerId = compareRemote.provider.id;
		const remotes = (await repo.getRemotes({
			filter: r => r.provider?.id === providerId,
		})) as GitRemote<RemoteProvider>[];

		const resource: RemoteResource = {
			type: RemoteResourceType.CreatePullRequest,
			base: {
				branch: args.base,
				remote: undefined!,
			},
			compare: {
				branch: args.compare,
				remote: { path: compareRemote.path, url: compareRemote.url },
			},
		};

		void (await executeCommand<OpenOnRemoteCommandArgs>(Commands.OpenOnRemote, {
			resource: resource,
			remotes: remotes,
		}));
	}
}
