/**
 * 環境変数の読み取り。
 *
 * Vite は VITE_ 接頭辞の変数だけをバンドルに埋め込む。
 * ブラウザに出るのは anon キーのみで、これは RLS 前提で公開されることを想定した鍵。
 * service_role キーは Worker 側の secret としてのみ扱い、この層には絶対に持ち込まない。
 *
 * 未設定のときに例外で落とさないのは、セットアップ手順を画面で案内するため。
 * 初見の人が「白い画面とコンソールのエラー」に出会うのを避ける。
 */

const url = import.meta.env.VITE_SUPABASE_URL ?? '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

export const supabaseConfig = { url, anonKey } as const;

export const isSupabaseConfigured = url.length > 0 && anonKey.length > 0;
