import type {RpcStub} from "cloudflare:workers";
import type {
  Gatekeeper, ObservationAuthorizer, SlashCommandResult,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  SlashCommandChoice, SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import type {SessionContext} from "@gadgets/workshop-shared/gatekeeper";

type SlashCommandGatekeeper = Fetcher<Gatekeeper<any> & Required<
  Pick<Gatekeeper<any>, "getSlashCommandProvider">
>>;

type SlashCommandSource = {
  gatekeeperId: number;
  providerLabel: string;
  gatekeeper: Fetcher<Gatekeeper<any>>;
};

// Collect the complete slash-command catalog from the attached Gatekeepers that advertise one.
//
// `context` scopes what each provider offers; it carries the workspace owner's org, matching the
// authority the commands run with.
export async function collectSlashCommands(
    sources: SlashCommandSource[], context?: SessionContext): Promise<SlashCommandChoice[]> {
  let catalogs = await Promise.all(sources.map(async source => {
    try {
      using provider = await (source.gatekeeper as SlashCommandGatekeeper)
          .getSlashCommandProvider(context);
      let commands = await provider.list();
      return commands.map(command => ({
        selection: {gatekeeperId: source.gatekeeperId, commandId: command.id},
        name: command.name,
        description: command.description,
        providerLabel: source.providerLabel,
        ...(command.resourceLabel ? {resourceLabel: command.resourceLabel} : {}),
      } satisfies SlashCommandChoice));
    } catch (error) {
      console.error(`Failed to load slash commands for gatekeeper ${source.gatekeeperId}:`, error);
      return [];
    }
  }));

  return catalogs.flat().toSorted((left, right) =>
    left.name.localeCompare(right.name) ||
    left.providerLabel.localeCompare(right.providerLabel) ||
    (left.resourceLabel ?? "").localeCompare(right.resourceLabel ?? "") ||
    left.selection.commandId.localeCompare(right.selection.commandId));
}

// Invoke one command on its selected attached Gatekeeper.
export async function invokeSlashCommand(
    gatekeeper: Fetcher<Gatekeeper<any>>, request: SlashCommandRequest,
    authorizer: RpcStub<ObservationAuthorizer>,
    context?: SessionContext): Promise<SlashCommandResult> {
  using provider = await (gatekeeper as SlashCommandGatekeeper).getSlashCommandProvider(context);
  return await provider.invoke(request.id.commandId, request.args, authorizer);
}
