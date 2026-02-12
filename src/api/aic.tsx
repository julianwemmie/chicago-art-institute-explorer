const BASE_API = "https://api.artic.edu/api/v1/artworks";
const IIIF_BASE = "https://www.artic.edu/iiif/2";
const ARTWORK_PAGE_BASE = "https://www.artic.edu/artworks";
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_REFILL_THRESHOLD = 5;

type Artwork = {
  id: number;
  title: string;
  image_id: string | null;
};

export type ArtworkImage = {
  id: number;
  title: string;
  width: number;
  height: number;
  imageUrl: string;
  largeImageUrl: string;
  infoUrl: string;
};

export type GeneratorOptions = {
  batchSize?: number;
  refillThreshold?: number;
  imageWidth?: number;
  seed?: number;
};

export type DataGeneratorFunc = () => Promise<ArtworkImage>;

async function buildArtworkImage(artwork: Artwork): Promise<ArtworkImage | null> {
  if (!artwork.image_id) {
    return null;
  }

  const infoUrl = `${IIIF_BASE}/${artwork.image_id}/info.json`;
  const infoRes = await fetch(infoUrl);
  if (!infoRes.ok) {
    return null;
  }
  const info = await infoRes.json();
  const width = Number(info.width);
  const height = Number(info.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const maxSize = Array.isArray(info.sizes)
    ? Math.max(...info.sizes.map((s: any) => Number(s.width)).filter((w: number) => Number.isFinite(w)))
    : 0;
  if (maxSize < 843) {
    return null;
  }

  const imageUrl = `${IIIF_BASE}/${artwork.image_id}/full/400,/0/default.jpg`;
  const largeImageUrl = `${IIIF_BASE}/${artwork.image_id}/full/843,/0/default.jpg`;

  return {
    id: artwork.id,
    title: artwork.title ?? "Artwork",
    width,
    height,
    imageUrl,
    largeImageUrl,
    infoUrl: `${ARTWORK_PAGE_BASE}/${artwork.id}`,
  };
}

/**
 * Returns a generator function that yields a fresh artwork image each time it is called.
 * The generator keeps a buffer (default 25) populated with Art Institute of Chicago artworks
 * and refills the buffer as it gets low so callers always receive a unique image.
 */
export function createAICImageDataGenerator(
  options: GeneratorOptions = {}
): DataGeneratorFunc {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const refillThreshold = options.refillThreshold ?? DEFAULT_REFILL_THRESHOLD;
  const seed = options.seed ?? Math.random();

  let buffer: ArtworkImage[] = [];
  let nextPage: number | null = null;
  let totalPages: number | null = null;
  let inflight: Promise<void> | null = null;
  const seenIds = new Set<number | string>();

  const ensurePaginationInfo = async (): Promise<void> => {
    if (totalPages !== null && nextPage !== null) {
      return;
    }

    try {
      const metaRes = await fetch(`${BASE_API}?page=1&limit=${batchSize}&fields=id`);
      if (!metaRes.ok) {
        nextPage = 1;
        totalPages = null;
        return;
      }
      const metaPayload = await metaRes.json();
      const pages = Number(metaPayload?.pagination?.total_pages);
      if (Number.isFinite(pages) && pages > 0) {
        totalPages = pages;
        const normalizedSeed = Math.abs(seed % 1);
        // Cap starting page to 1-25 so demo loads are more likely to hit cached responses
        nextPage = Math.floor(normalizedSeed * Math.min(pages, 25)) + 1
      } else {
        totalPages = null;
        nextPage = 1;
      }
    } catch {
      nextPage = 1;
      totalPages = null;
    }
  };

  const updateNextPage = (currentPage: number): void => {
    if (totalPages && totalPages > 0) {
      nextPage = currentPage >= totalPages ? 1 : currentPage + 1;
    } else {
      nextPage = currentPage + 1;
    }
  };

  const fetchNextBatch = async (): Promise<void> => {
    await ensurePaginationInfo();

    const requestedPage = nextPage ?? 1;
    const url = `${BASE_API}?page=${requestedPage}&limit=${batchSize}&fields=id,title,image_id`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`AIC API error: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    const pages = Number(payload?.pagination?.total_pages);
    if (Number.isFinite(pages) && pages > 0) {
      totalPages = pages;
    }
    updateNextPage(requestedPage);
    const artworks: Artwork[] = Array.isArray(payload?.data) ? payload.data : [];

    const newImages = await Promise.all(
      artworks
        .filter((art) => art.image_id && !seenIds.has(art.id))
        .map(async (art) => {
          try {
            return await buildArtworkImage(art);
          } catch {
            return null;
          }
        })
    );

    for (const img of newImages) {
      if (img && !seenIds.has(img.id!)) {
        seenIds.add(img.id!);
        buffer.push(img);
      }
    }
  };

  const ensureBatch = (): Promise<void> => {
    if (!inflight) {
      inflight = fetchNextBatch().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };

  const triggerRefill = () => {
    ensureBatch().catch((error) => {
      console.error("Failed to refill AIC image buffer", error);
    });
  };

  const generator: DataGeneratorFunc = async (): Promise<ArtworkImage> => {
    if (buffer.length === 0) {
      await ensureBatch();
    }
    const next = buffer.shift();
    if (!next) {
      throw new Error("AIC generator could not supply an image");
    }
    if (buffer.length <= refillThreshold) {
      triggerRefill();
    }

    return next;
  };

  return generator;
}
