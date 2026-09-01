import "server-only";

/**
 * Hand written row types for the tables the API layer touches.
 *
 * These match supabase/migrations exactly and exist so the server has real
 * types before the Supabase project is up. `npm run db:types` regenerates the
 * full schema from the live database; when it does, replace this file with the
 * generated one and keep the aliases at the bottom.
 *
 * Only the tables the routes, jobs, credits, judge, and rate limit layers read
 * or write are declared. A table that is missing here is a compile error at the
 * call site rather than a silent `any`, which is the point.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type AnalysisKind =
  | "skin"
  | "fitzpatrick"
  | "attributes"
  | "face_shape"
  | "hair_type";

export type JobStatus = "pending" | "running" | "succeeded" | "failed";

export type JobSubjectType = "analysis" | "render" | "classification";

export type CreditOwnerType = "user" | "judge_session";

export type CreditProvider = "perfectcorp" | "serpapi" | "anthropic";

/** The renders.kind check in migrations 0003 and 0010. */
export type RenderKind =
  | "makeup"
  | "hairstyle"
  | "hair_color"
  | "cloth"
  | "accessory"
  | "skin_simulation";

type ProfileRow = {
  user_id: string;
  display_name: string | null;
  consent_at: string;
  consent_version: string;
  is_adult_confirmed: boolean;
  keep_originals: boolean;
  location_consent: boolean;
  approx_location: Json | null;
  created_at: string;
  updated_at: string;
};

type CaptureRow = {
  id: string;
  user_id: string;
  sha256: string;
  storage_path: string | null;
  width: number | null;
  height: number | null;
  quality: Json | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type AnalysisRow = {
  id: string;
  capture_id: string;
  user_id: string;
  kind: AnalysisKind;
  status: JobStatus;
  provider_task_id: string | null;
  raw: Json | null;
  summary: Json | null;
  mask_paths: Json | null;
  credits_used: number;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type JobRow = {
  id: string;
  user_id: string;
  subject_type: JobSubjectType;
  subject_id: string | null;
  status: JobStatus;
  provider_task_id: string | null;
  attempts: number;
  last_polled_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type CreditLedgerRow = {
  id: string;
  owner_type: CreditOwnerType;
  owner_id: string;
  provider: CreditProvider;
  units: number;
  subject_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

type JudgeSessionRow = {
  id: string;
  code_hash: string;
  expires_at: string;
  analyses_allowed: number;
  analyses_used: number;
  credits_cap: number;
  credits_used: number;
  last_seen_at: string | null;
  /** Consent columns added in migration 0008 so a judge can consent too. */
  consent_at: string | null;
  consent_version: string | null;
  is_adult_confirmed: boolean;
  keep_originals: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * One garment photo, migration 0003.
 *
 * type, pattern, and colors are the classifier's answer or the person's
 * correction; all three are nullable because a garment can exist before either
 * has happened (docs/01-user-flow.md section J, the classifying and failed card
 * states). The vocabulary those columns are checked against lives in
 * src/lib/shared/wardrobe-view.ts; only formality is also a check constraint in
 * SQL, which is why it is the one column typed to its union here.
 *
 * storage_path is not null: the path is computed from the id the app generates,
 * so the row and its object in the garments bucket are written together.
 */
type GarmentRow = {
  id: string;
  user_id: string;
  /** Object path inside the garments bucket: <user_id>/<garment_id>.<ext> */
  storage_path: string;
  type: string | null;
  /** [{ name, hex }], the classifier output shape. */
  colors: Json;
  pattern: string | null;
  formality: "casual" | "smart" | "formal" | null;
  /** The full model output including confidence, or null before any call. */
  classification: Json | null;
  /** True once the person corrected a chip, so nothing overwrites them. */
  user_edited: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * One composed outfit for one occasion, migration 0003.
 *
 * occasion is text rather than a union: the six occasions live in
 * src/lib/shared/looks-view.ts and the column has no check constraint, so the
 * looks layer is what narrows it on the way in and on the way out.
 *
 * garments is an ordered array whose members are either { garment_id } for an
 * owned piece or a normalized listing for a gap (the column comment in the
 * migration). It is Json here because the two shapes are the looks layer's
 * decision, validated with zod where it is read.
 */
type LookRow = {
  id: string;
  user_id: string;
  occasion: string | null;
  garments: Json;
  rationale: string | null;
  /** Object path in the renders bucket for the hero garment try on. */
  render_path: string | null;
  is_saved: boolean;
  created_at: string;
  updated_at: string;
};

type RenderRow = {
  id: string;
  user_id: string;
  kind: RenderKind;
  params: Json;
  params_hash: string;
  storage_path: string | null;
  provider_task_id: string | null;
  credits_used: number;
  status: JobStatus;
  created_at: string;
  updated_at: string;
};

/**
 * Server owned cache of normalized provider search results, migration 0004.
 * Freshness is a read time rule, not a column constraint: 24 hours for shopping,
 * 6 hours for local (docs/03-architecture.md, "Caching"). fetched_at is when the
 * provider was actually called; created_at is not a freshness signal.
 */
type ProductCacheRow = {
  query_hash: string;
  engine: string;
  query: Json;
  results: Json;
  fetched_at: string;
  created_at: string;
  updated_at: string;
};

type RateLimitRow = {
  bucket: string;
  subject: string;
  tokens: number;
  refilled_at: string;
  created_at: string;
  updated_at: string;
};

type AestheticProfileRow = {
  user_id: string;
  capture_id: string | null;
  skin_type_zones: Json | null;
  concerns: Json;
  skin_age: number | null;
  fitzpatrick: number | null;
  skin_tone_hex: string | null;
  undertone: string | null;
  undertone_source: string | null;
  eye_color_hex: string | null;
  hair_color_hex: string | null;
  face_shape: string | null;
  hair_type: Json | null;
  /** Migration 0009. The catalog style id behind "Save this" on /hair. */
  saved_hair_style_id: string | null;
  /** Migration 0009. The catalog color name saved with it, or null for none. */
  saved_hair_color_name: string | null;
  season: string | null;
  palette: Json | null;
  reading: string | null;
  reading_model: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

/** Columns a writer may omit because the database fills them. */
type Generated = "id" | "created_at" | "updated_at";

type InsertOf<Row, Optional extends keyof Row> = Omit<Row, Optional> &
  Partial<Pick<Row, Optional>>;

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: InsertOf<
          ProfileRow,
          | "created_at"
          | "updated_at"
          | "consent_version"
          | "display_name"
          | "keep_originals"
          | "location_consent"
          | "approx_location"
        >;
        Update: Partial<ProfileRow>;
        Relationships: [];
      };
      captures: {
        Row: CaptureRow;
        Insert: InsertOf<
          CaptureRow,
          Generated | "storage_path" | "width" | "height" | "quality" | "deleted_at"
        >;
        Update: Partial<CaptureRow>;
        Relationships: [];
      };
      analyses: {
        Row: AnalysisRow;
        Insert: InsertOf<
          AnalysisRow,
          | Generated
          | "status"
          | "provider_task_id"
          | "raw"
          | "summary"
          | "mask_paths"
          | "credits_used"
          | "error"
        >;
        Update: Partial<AnalysisRow>;
        Relationships: [];
      };
      aesthetic_profiles: {
        Row: AestheticProfileRow;
        Insert: Partial<AestheticProfileRow> & { user_id: string };
        Update: Partial<AestheticProfileRow>;
        Relationships: [];
      };
      jobs: {
        Row: JobRow;
        Insert: InsertOf<
          JobRow,
          | Generated
          | "status"
          | "provider_task_id"
          | "attempts"
          | "last_polled_at"
          | "error"
          | "subject_id"
        >;
        Update: Partial<JobRow>;
        Relationships: [];
      };
      credit_ledger: {
        Row: CreditLedgerRow;
        Insert: InsertOf<CreditLedgerRow, Generated | "subject_id" | "note">;
        Update: Partial<CreditLedgerRow>;
        Relationships: [];
      };
      judge_sessions: {
        Row: JudgeSessionRow;
        Insert: InsertOf<
          JudgeSessionRow,
          | Generated
          | "analyses_allowed"
          | "analyses_used"
          | "credits_used"
          | "last_seen_at"
          | "consent_at"
          | "consent_version"
          | "is_adult_confirmed"
          | "keep_originals"
        >;
        Update: Partial<JudgeSessionRow>;
        Relationships: [];
      };
      garments: {
        Row: GarmentRow;
        Insert: InsertOf<
          GarmentRow,
          | Generated
          | "type"
          | "colors"
          | "pattern"
          | "formality"
          | "classification"
          | "user_edited"
        >;
        Update: Partial<GarmentRow>;
        Relationships: [];
      };
      looks: {
        Row: LookRow;
        Insert: InsertOf<
          LookRow,
          | Generated
          | "occasion"
          | "garments"
          | "rationale"
          | "render_path"
          | "is_saved"
        >;
        Update: Partial<LookRow>;
        Relationships: [];
      };
      renders: {
        Row: RenderRow;
        Insert: InsertOf<
          RenderRow,
          | Generated
          | "params"
          | "storage_path"
          | "provider_task_id"
          | "credits_used"
          | "status"
        >;
        Update: Partial<RenderRow>;
        Relationships: [];
      };
      product_cache: {
        Row: ProductCacheRow;
        Insert: InsertOf<
          ProductCacheRow,
          "created_at" | "updated_at" | "fetched_at" | "results"
        >;
        Update: Partial<ProductCacheRow>;
        Relationships: [];
      };
      rate_limits: {
        Row: RateLimitRow;
        Insert: InsertOf<RateLimitRow, "created_at" | "updated_at">;
        Update: Partial<RateLimitRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

type PublicTables = Database["public"]["Tables"];

export type Row<Table extends keyof PublicTables> = PublicTables[Table]["Row"];
export type Insert<Table extends keyof PublicTables> =
  PublicTables[Table]["Insert"];

export type Profile = Row<"profiles">;
export type Capture = Row<"captures">;
export type Analysis = Row<"analyses">;
export type JobRecord = Row<"jobs">;
export type CreditLedgerEntry = Row<"credit_ledger">;
export type JudgeSession = Row<"judge_sessions">;
export type Garment = Row<"garments">;
export type Look = Row<"looks">;
export type Render = Row<"renders">;
export type ProductCacheEntry = Row<"product_cache">;
export type RateLimitBucketRow = Row<"rate_limits">;

/** The five analyses that fan out from one capture, in reveal order. */
export const ANALYSIS_KINDS: readonly AnalysisKind[] = [
  "skin",
  "fitzpatrick",
  "attributes",
  "face_shape",
  "hair_type",
];


