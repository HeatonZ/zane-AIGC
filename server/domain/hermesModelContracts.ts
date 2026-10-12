/** Serializable response contract for the read-only Hermes model catalog; consumed by the
 *  browser, HTTP and MCP. No credentials, key environment names or upstream endpoints. */
export interface HermesModelProviderSummary {
  slug: string;
  name: string;
  isCurrent: boolean;
  authenticated: boolean;
  isUserDefined: boolean;
  models: string[];
  totalModels: number;
  modelsTruncated: boolean;
}

export interface HermesModelCatalogPage {
  profile: string;
  revision: string;
  currentProvider: string;
  currentModel: string;
  providers: HermesModelProviderSummary[];
  hasMore: boolean;
  nextCursor?: string;
  fetchedAt: string;
  nextAction: string;
}

export interface HermesProfileSummary {
  id: string;
  isDefault: boolean;
}

export interface HermesProfilePage {
  profiles: HermesProfileSummary[];
  nextAction: string;
}
