/**
 * Simulated provider records → contract DTOs. This is the simulator's equivalent of a real adapter's
 * normalization step (provider payload → DTO); golden tests pin its output.
 */
import type {
  AccountDescriptionDto,
  AdDto,
  AdGroupDto,
  AuthorDto,
  CampaignDto,
  ContentDto,
  InteractionDto,
  SocialAssetDto,
} from "../contract/dto";
import { providerObjectRef, rawReference, type ProviderObjectRef, type RawReference } from "../contract/identity";
import type { ScenarioAd, ScenarioAdGroup, ScenarioAuthor, ScenarioContent, ScenarioPaidObject } from "./scenario";
import type { AssetState, InteractionState, SimulatorWorld } from "./world";

export function simRaw(world: SimulatorWorld, kind: string, id: string, revision?: string | null): RawReference {
  const suffix = revision === undefined || revision === null ? "" : `@${revision}`;
  return rawReference("simulator", world.scenario.apiVersion, `sim://${world.scenario.scenarioId}/${kind}/${id}${suffix}`);
}

function assetOf(world: SimulatorWorld, id: string): AssetState {
  const asset = world.asset(id);
  if (asset === undefined) throw new TypeError("unknown simulated asset");
  return asset;
}

export function assetRef(world: SimulatorWorld, id: string): ProviderObjectRef<"asset"> {
  return providerObjectRef(assetOf(world, id).platform, "asset", id);
}

export function contentRef(world: SimulatorWorld, content: ScenarioContent): ProviderObjectRef<"content"> {
  return providerObjectRef(assetOf(world, content.account).platform, "content", content.id);
}

export function interactionRef(world: SimulatorWorld, interaction: InteractionState): ProviderObjectRef<"interaction"> {
  const content = world.content(interaction.content);
  if (content === undefined) throw new TypeError("unknown simulated content");
  return providerObjectRef(assetOf(world, content.account).platform, "interaction", interaction.id);
}

export function socialAssetDto(world: SimulatorWorld, asset: AssetState): SocialAssetDto {
  return {
    ref: assetRef(world, asset.id),
    assetClass: asset.assetClass,
    displayName: asset.displayName,
    relatedAssets: asset.linkedAdAccounts.map((id) => assetRef(world, id)),
    rawReference: simRaw(world, "asset", asset.id),
  };
}

export function accountDescriptionDto(world: SimulatorWorld, asset: AssetState): AccountDescriptionDto {
  return {
    asset: assetRef(world, asset.id),
    assetClass: asset.assetClass,
    displayName: asset.displayName,
    accountIdentity: asset.identity === null ? null : providerObjectRef(asset.platform, "author", asset.identity),
    grantedPermissions: [...asset.permissions].sort(),
    linkedAdAccounts: asset.linkedAdAccounts.map((id) => assetRef(world, id)),
    describedAt: world.now(),
    rawReference: simRaw(world, "account", asset.id),
  };
}

export function authorDto(author: ScenarioAuthor): AuthorDto {
  return {
    ref: providerObjectRef(author.platform, "author", author.id),
    role: author.role,
    displayName: author.displayName,
    handle: author.handle,
  };
}

export function contentDto(world: SimulatorWorld, content: ScenarioContent): ContentDto {
  return {
    ref: contentRef(world, content),
    account: assetRef(world, content.account),
    contentKind: content.kind,
    reportedSource: content.reportedSource,
    caption: content.availability === "removed_at_source" ? null : content.caption,
    publishedAt: content.publishedAt,
    availability: content.availability,
    timestamps: { createdAt: content.publishedAt, updatedAt: null },
    rawReference: simRaw(world, "content", content.id),
  };
}

export function interactionDto(world: SimulatorWorld, state: InteractionState): InteractionDto {
  const content = world.content(state.content);
  const author = world.author(state.author);
  if (content === undefined || author === undefined) throw new TypeError("inconsistent simulated interaction");
  const parent = state.parent === null ? undefined : world.interaction(state.parent);
  const removed = state.presence === "removed_signaled";
  return {
    ref: interactionRef(world, state),
    content: contentRef(world, content),
    parent: parent === undefined ? null : interactionRef(world, parent),
    interactionKind: state.parent === null ? "comment" : "reply",
    author: authorDto(author),
    text: removed ? null : state.text,
    textRevision: state.revision,
    editedAt: state.editedAt,
    visibility: state.visibility,
    availability: removed ? "removed_at_source" : "available",
    timestamps: { createdAt: state.createdAt, updatedAt: state.updatedAt },
    rawReference: simRaw(world, "interaction", state.id, state.revision),
  };
}

const paidTimestamps = (p: ScenarioPaidObject) => ({ createdAt: p.createdAt, updatedAt: null });

export function campaignDto(world: SimulatorWorld, c: ScenarioPaidObject): CampaignDto {
  const platform = assetOf(world, c.adAccount).platform;
  return {
    type: "campaign",
    ref: providerObjectRef(platform, "campaign", c.id),
    adAccount: assetRef(world, c.adAccount),
    name: c.name,
    status: c.status,
    timestamps: paidTimestamps(c),
    rawReference: simRaw(world, "campaign", c.id),
  };
}

export function adGroupDto(world: SimulatorWorld, g: ScenarioAdGroup): AdGroupDto {
  const platform = assetOf(world, g.adAccount).platform;
  return {
    type: "ad_group",
    ref: providerObjectRef(platform, "ad_group", g.id),
    adAccount: assetRef(world, g.adAccount),
    campaign: g.campaign === null ? null : providerObjectRef(platform, "campaign", g.campaign),
    name: g.name,
    status: g.status,
    timestamps: paidTimestamps(g),
    rawReference: simRaw(world, "ad_group", g.id),
  };
}

export function adDto(world: SimulatorWorld, ad: ScenarioAd): AdDto {
  const platform = assetOf(world, ad.adAccount).platform;
  const content = ad.content === null ? undefined : world.content(ad.content);
  return {
    type: "ad",
    ref: providerObjectRef(platform, "ad", ad.id),
    adAccount: assetRef(world, ad.adAccount),
    adGroup: ad.adGroup === null ? null : providerObjectRef(platform, "ad_group", ad.adGroup),
    campaign: ad.campaign === null ? null : providerObjectRef(platform, "campaign", ad.campaign),
    content: content === undefined ? null : contentRef(world, content),
    name: ad.name,
    status: ad.status,
    timestamps: paidTimestamps(ad),
    rawReference: simRaw(world, "ad", ad.id),
  };
}
