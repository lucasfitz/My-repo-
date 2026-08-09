// Built-in care guide: common houseplants with suggested schedules.
// waterDays / fertDays are growing-season defaults; winter tips adjust them.
const PLANT_GUIDE = [
  { key: "pothos", name: "Pothos", latin: "Epipremnum aureum", emoji: "🌿", waterDays: 7, fertDays: 30, light: "Low to bright indirect light", tips: "Nearly indestructible. Let the top 2–3 cm of soil dry out between waterings. Trim leggy vines to keep it bushy." },
  { key: "snake-plant", name: "Snake Plant", latin: "Dracaena trifasciata", emoji: "🪴", waterDays: 14, fertDays: 60, light: "Low to bright indirect light", tips: "Drought-tolerant — overwatering is the #1 killer. Water only when soil is fully dry. Great bedroom plant." },
  { key: "monstera", name: "Monstera", latin: "Monstera deliciosa", emoji: "🌱", waterDays: 7, fertDays: 30, light: "Bright indirect light", tips: "Loves a moss pole to climb. Wipe the big leaves monthly so they can breathe. Fenestrations appear with age and good light." },
  { key: "spider-plant", name: "Spider Plant", latin: "Chlorophytum comosum", emoji: "🕷️", waterDays: 7, fertDays: 30, light: "Bright indirect light", tips: "Produces baby plantlets you can pot up and share. Brown tips usually mean tap-water fluoride — try filtered water." },
  { key: "peace-lily", name: "Peace Lily", latin: "Spathiphyllum", emoji: "🕊️", waterDays: 5, fertDays: 45, light: "Low to medium indirect light", tips: "Dramatic but communicative — it droops visibly when thirsty and perks right back up after watering." },
  { key: "fiddle-leaf-fig", name: "Fiddle Leaf Fig", latin: "Ficus lyrata", emoji: "🎻", waterDays: 8, fertDays: 30, light: "Bright indirect light, some direct sun", tips: "Hates being moved — pick a bright spot and leave it there. Rotate a quarter turn each watering for even growth." },
  { key: "rubber-plant", name: "Rubber Plant", latin: "Ficus elastica", emoji: "🌳", waterDays: 8, fertDays: 30, light: "Medium to bright indirect light", tips: "Wipe leaves to keep them glossy. Let the top few cm of soil dry between waterings." },
  { key: "zz-plant", name: "ZZ Plant", latin: "Zamioculcas zamiifolia", emoji: "💚", waterDays: 14, fertDays: 60, light: "Low to bright indirect light", tips: "Stores water in rhizomes — thrives on neglect. Water thoroughly but infrequently." },
  { key: "aloe", name: "Aloe Vera", latin: "Aloe barbadensis", emoji: "🌵", waterDays: 14, fertDays: 90, light: "Bright direct light", tips: "Needs sandy, fast-draining soil. Water deeply, then let it dry out completely. Leaves wrinkle when thirsty." },
  { key: "succulent", name: "Succulents (mixed)", latin: "various", emoji: "🌵", waterDays: 14, fertDays: 90, light: "Bright direct light", tips: "Soak-and-dry method: drench, then wait for bone-dry soil. In winter, water as little as once a month." },
  { key: "philodendron", name: "Philodendron", latin: "Philodendron hederaceum", emoji: "🍃", waterDays: 7, fertDays: 30, light: "Medium to bright indirect light", tips: "Heartleaf varieties trail beautifully from shelves. Yellow leaves usually mean overwatering." },
  { key: "calathea", name: "Calathea / Prayer Plant", latin: "Goeppertia spp.", emoji: "🦚", waterDays: 5, fertDays: 30, light: "Medium indirect light, no direct sun", tips: "Diva alert: wants high humidity and distilled or rain water. Leaves fold up at night — that's normal and charming." },
  { key: "boston-fern", name: "Boston Fern", latin: "Nephrolepis exaltata", emoji: "🌾", waterDays: 4, fertDays: 30, light: "Bright indirect light", tips: "Keep soil consistently moist and mist often — loves bathrooms. Crispy fronds mean the air is too dry." },
  { key: "orchid", name: "Orchid", latin: "Phalaenopsis", emoji: "🌸", waterDays: 8, fertDays: 21, light: "Bright indirect light", tips: "Water by soaking the bark pot for 15 min, then drain fully. After blooms drop, cut the spike above a node for a rebloom." },
  { key: "english-ivy", name: "English Ivy", latin: "Hedera helix", emoji: "🍀", waterDays: 6, fertDays: 30, light: "Medium to bright indirect light", tips: "Likes cooler rooms. Check under leaves for spider mites — a quick shower knocks them off." },
  { key: "chinese-money", name: "Chinese Money Plant", latin: "Pilea peperomioides", emoji: "🪙", waterDays: 7, fertDays: 30, light: "Bright indirect light", tips: "Rotate often — it leans hard toward light. Produces pups you can gift to friends (its nickname: friendship plant)." },
  { key: "bird-of-paradise", name: "Bird of Paradise", latin: "Strelitzia nicolai", emoji: "🐦", waterDays: 7, fertDays: 30, light: "Bright light, tolerates direct sun", tips: "A thirsty, fast grower in summer. Split leaves are natural and help it handle wind in the wild." },
  { key: "dracaena", name: "Dracaena", latin: "Dracaena marginata", emoji: "🌴", waterDays: 10, fertDays: 45, light: "Medium to bright indirect light", tips: "Sensitive to fluoride — filtered water prevents brown tips. Very forgiving if you forget a watering." },
  { key: "hoya", name: "Hoya / Wax Plant", latin: "Hoya carnosa", emoji: "🌺", waterDays: 10, fertDays: 30, light: "Bright indirect light", tips: "Semi-succulent — let it dry well between waterings. Don't cut the old flower spurs; it reblooms from them." },
  { key: "cactus", name: "Cactus", latin: "Cactaceae", emoji: "🌵", waterDays: 21, fertDays: 90, light: "Bright direct light", tips: "Water deeply but rarely. In winter, many cacti prefer almost no water at all — it triggers spring blooms." },
  { key: "herb", name: "Kitchen Herbs", latin: "basil, mint, parsley…", emoji: "🌿", waterDays: 3, fertDays: 21, light: "Bright direct light (south window)", tips: "Pinch flowers off basil to keep leaves tender. Harvest often — cutting encourages bushier growth." },
  { key: "other", name: "Other / Not sure", latin: "", emoji: "🪴", waterDays: 7, fertDays: 30, light: "Check the nursery tag", tips: "When in doubt: bright indirect light, water when the top few cm of soil are dry, and fertilize monthly in spring/summer." }
];

const SEASONAL_TIPS = {
  winter: "❄️ Winter mode: most plants rest now. Stretch watering intervals ~50% longer, pause fertilizing, and move plants away from cold windows and heat vents.",
  spring: "🌷 Spring: growth is restarting. Resume regular fertilizing, repot anything root-bound, and start propagating cuttings.",
  summer: "☀️ Summer: peak growing season. Plants drink more — check soil a day or two early on hot weeks, and shield delicate leaves from harsh afternoon sun.",
  autumn: "🍂 Autumn: growth is slowing. Taper off fertilizer, ease up on watering, and give leaves a good dusting before the low-light months."
};

function currentSeason(d = new Date()) {
  const m = d.getMonth(); // northern hemisphere
  if (m === 11 || m <= 1) return "winter";
  if (m <= 4) return "spring";
  if (m <= 7) return "summer";
  return "autumn";
}
