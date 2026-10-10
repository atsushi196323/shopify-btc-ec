// version の競合で DB を読み直して判定し直す回数。ワーカー・無効化・再発行で同じ値を使う（ADR 8 の決定3）
export const MAX_CONFLICT_RETRIES = 3;
