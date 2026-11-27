const MIN_PHOTO_WIDTH = 112;
const MAX_PHOTO_WIDTH = 560;
const POWER = 0.24;

/**
 * Display width for a photo at an arrival rank (rank 1 = freshest).
 * A gentle power law makes each subsequent photo a little smaller while a
 * practical floor keeps long histories readable.
 */
export function wallPhotoWidth(rank: number, boardWidth: number): number {
  if (!Number.isFinite(boardWidth) || boardWidth <= 0) return MIN_PHOTO_WIDTH;
  const safeRank = Math.max(1, Math.floor(rank));
  const base =
    boardWidth < 640
      ? Math.min(320, boardWidth * 0.84)
      : Math.min(MAX_PHOTO_WIDTH, boardWidth * 0.46);
  const raw = base * Math.pow(safeRank, -POWER);
  return Math.round(
    Math.min(MAX_PHOTO_WIDTH, boardWidth, Math.max(MIN_PHOTO_WIDTH, raw)),
  );
}
