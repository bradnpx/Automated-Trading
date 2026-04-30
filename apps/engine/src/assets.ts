// apps/engine/src/assets.ts
import Alpaca from '@alpacahq/alpaca-trade-api';

const alpaca = new Alpaca();

export async function getBiotechWatchlist() {
  const assets = await alpaca.getAssets({
    status: 'active',
    asset_class: 'us_equity',
  });

  // Simple filter for common biotech indicators in names/symbols
  // In a production app, you'd likely use a dedicated screener API (like Polygon)
  const biotechTickers = assets.filter(asset => 
    asset.tradable && 
    asset.shortable &&
    (asset.name.toLowerCase().includes('biotech') || 
     asset.name.toLowerCase().includes('therapeutics') ||
     asset.name.toLowerCase().includes('pharma'))
  );

  return biotechTickers.map(a => a.symbol);
}