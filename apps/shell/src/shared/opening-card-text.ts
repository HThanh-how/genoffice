import type { OpeningCardDefinition } from './opening-card-types'
import { sceneMeta } from './opening-scenes-meta'

/**
 * What each built-in card is called and what it shows, in the two languages the studio speaks.
 * Every line says only what the card renders (checked against the scene code and the material
 * CSS), and says it briefly. Motion claims are the ones the code makes: "drifts" only where
 * something moves.
 */
export interface CardText {
  nameVi: string
  en: string
  vi: string
}

export const SCENE_TEXT: Record<string, { en: string; vi: string }> = {
  ocean: {
    en: 'Jellyfish pulse and small fish swim through deep water, with light rays from above.',
    vi: 'Sứa phập phồng, đàn cá nhỏ bơi qua làn nước sâu, có những tia sáng chiếu xuống.',
  },
  aurora: {
    en: 'Green and violet aurora curtains ripple over a dark pine ridge and a still lake, under twinkling stars.',
    vi: 'Cực quang xanh lục và tím gợn sóng trên dải thông tối và mặt hồ phẳng lặng, dưới bầu trời sao lấp lánh.',
  },
  moonsea: {
    en: 'A full moon over a dark sea with a glittering path of light; a tiny sailboat drifts slowly across.',
    vi: 'Trăng tròn trên mặt biển đen với vệt sáng lấp lánh; một chiếc thuyền buồm nhỏ trôi chậm ngang qua.',
  },
  lotus: {
    en: 'Koi swim among lotus flowers and lily pads in a green pond, with soft shafts of light.',
    vi: 'Cá chép bơi giữa hoa sen và lá sen trong hồ xanh, có những chùm sáng dịu.',
  },
  mountains: {
    en: 'Layered mountain ridges in drifting mist, with a pale sun glowing behind them and a few distant birds.',
    vi: 'Những dãy núi chồng lớp trong màn sương trôi, mặt trời nhạt sáng phía sau và vài cánh chim xa.',
  },
  pages: {
    en: 'Small paper pages float upward, turning as they go, over a deep blue background.',
    vi: 'Những trang giấy nhỏ lơ lửng bay lên và xoay nhẹ trên nền xanh thẫm.',
  },
  snow: {
    en: 'Snow falls around a log cabin with lit windows and curling chimney smoke, between pine trees and a small moon.',
    vi: 'Tuyết rơi quanh căn nhà gỗ sáng đèn có khói bay lên từ ống khói, giữa những cây thông và vầng trăng nhỏ.',
  },
  jungle: {
    en: 'Fireflies glow and drift in a dark jungle, among hanging vines and large leaves.',
    vi: 'Đom đóm phát sáng và bay lượn trong khu rừng tối, giữa dây leo rủ và những tán lá lớn.',
  },
  rice: {
    en: 'A golden rice field sways under a low glowing sun, with white egrets flying across.',
    vi: 'Ruộng lúa vàng lay động dưới mặt trời thấp, những chú cò trắng bay ngang qua.',
  },
  bamboo: {
    en: 'Tall bamboo stalks in mist, with slanting light and a few falling leaves.',
    vi: 'Rừng tre cao trong sương, có ánh sáng xiên và vài chiếc lá rơi.',
  },
  butterflies: {
    en: 'Butterflies flutter over a meadow of small flowers in soft green light.',
    vi: 'Bướm chập chờn trên đồng cỏ đầy hoa nhỏ trong ánh sáng xanh dịu.',
  },
  grid: {
    en: 'A dark green grid of cells where numbered cells light up in rippling waves, like a spreadsheet.',
    vi: 'Lưới ô xanh thẫm, những ô có số sáng lên lan thành từng đợt sóng, như một bảng tính.',
  },
  matrix: {
    en: 'Columns of green characters fall down the screen like digital rain.',
    vi: 'Những cột ký tự xanh lục rơi dọc màn hình như cơn mưa số.',
  },
  sunrise: {
    en: 'Hot-air balloons rise past soft clouds in a warm sunrise sky.',
    vi: 'Những khinh khí cầu bay lên giữa mây mềm trên nền trời bình minh ấm.',
  },
  cloudsea: {
    en: 'Pink and purple cloud banks roll slowly under a dusk sky, with a few distant birds.',
    vi: 'Những tầng mây hồng và tím cuộn chậm dưới bầu trời chiều, thấp thoáng vài cánh chim xa.',
  },
  kites: {
    en: 'Kites on long strings fly in a blue sky with drifting clouds, above a grassy hill.',
    vi: 'Những cánh diều trên dây dài bay trong bầu trời xanh có mây trôi, phía trên một ngọn đồi cỏ.',
  },
  sunsetbeach: {
    en: 'The sun sets over a calm sea with a glittering reflection; palm trees stand on the left and birds fly by.',
    vi: 'Mặt trời lặn trên mặt biển lặng với vệt sáng lấp lánh; hàng dừa bên trái và những cánh chim bay qua.',
  },
  leaves: {
    en: 'Red and gold autumn leaves fall through slanting beams of light.',
    vi: 'Lá thu đỏ và vàng rơi xuyên qua những chùm sáng xiên.',
  },
  lanterns: {
    en: 'Glowing lanterns float upward into a starry night sky.',
    vi: 'Những chiếc đèn lồng sáng bay lên bầu trời đêm đầy sao.',
  },
  fireworks: {
    en: 'Fireworks burst in many colors over a dark riverbank, with faint reflections below.',
    vi: 'Pháo hoa nhiều màu nổ trên bờ sông tối, có những vệt phản chiếu mờ bên dưới.',
  },
  city: {
    en: 'A night skyline with lit windows, a moon and slow dark clouds.',
    vi: 'Đường chân trời thành phố về đêm với cửa sổ sáng đèn, vầng trăng và những đám mây tối trôi chậm.',
  },
  rain: {
    en: 'Raindrops run down a window at night, with blurred city lights behind the glass.',
    vi: 'Giọt mưa lăn dài trên cửa kính ban đêm, phía sau là ánh đèn thành phố nhòe mờ.',
  },
  campfire: {
    en: 'A campfire crackles with rising sparks between two tents, under the stars.',
    vi: 'Lửa trại bập bùng bắn tia lửa bay lên giữa hai chiếc lều, dưới bầu trời sao.',
  },
  desert: {
    en: 'A bright moon with a halo above rolling sand dunes.',
    vi: 'Vầng trăng sáng có quầng phía trên những đồi cát nhấp nhô.',
  },
  galaxy: {
    en: 'A spiral galaxy of stars slowly turns around a bright core.',
    vi: 'Thiên hà xoắn ốc gồm vô số ngôi sao quay chậm quanh một lõi sáng.',
  },
  warp: {
    en: 'Streaks of light rush outward from the center, as if flying at light speed.',
    vi: 'Những vệt sáng lao ra từ tâm màn hình, như đang bay với tốc độ ánh sáng.',
  },
  synthwave: {
    en: 'A striped retro sun sits above a neon grid whose lines keep rolling toward you.',
    vi: 'Mặt trời sọc kiểu retro phía trên lưới neon có các đường liên tục chạy về phía bạn.',
  },
  waves: {
    en: 'Glowing neon lines flow in slow waves.',
    vi: 'Những đường neon phát sáng uốn lượn thành sóng chậm.',
  },
  lava: {
    en: 'Soft glowing blobs of color drift up and down, like a lava lamp.',
    vi: 'Những đốm màu phát sáng mềm trôi lên xuống như đèn dung nham.',
  },
  bubbles: {
    en: 'Soap bubbles with shifting rainbow edges float upward.',
    vi: 'Bong bóng xà phòng với viền cầu vồng đổi màu bay lên.',
  },
  ink: {
    en: 'Soft clouds of blue-green ink slowly bloom and fade in dark water.',
    vi: 'Những đám mực xanh lam – xanh lục nở chậm rồi tan dần trong làn nước tối.',
  },
  sakura: {
    en: 'A cherry-blossom branch with petals drifting down.',
    vi: 'Một cành hoa anh đào với những cánh hoa lả tả rơi xuống.',
  },
}

export const MATERIAL_TEXT: Record<string, CardText> = {
  'curated:frosted-blue': {
    nameVi: 'Kính mờ xanh',
    en: 'Translucent frosted glass with an icy blue tint that softly blurs what is behind it.',
    vi: 'Kính mờ trong suốt phủ sắc xanh lạnh, làm nhòe nhẹ những gì phía sau.',
  },
  'curated:crystal-white': {
    nameVi: 'Pha lê trắng',
    en: 'Bright translucent white glass with crisp light edges and a diagonal band of light.',
    vi: 'Kính trắng sáng, trong suốt, viền sáng sắc nét và một dải sáng chéo.',
  },
  'curated:graphite': {
    nameVi: 'Than chì',
    en: 'Deep charcoal that shades from lighter grey at the top to near-black, with a fine light edge.',
    vi: 'Màu than đậm chuyển từ xám sáng hơn ở trên xuống gần đen, có viền sáng mảnh.',
  },
  'curated:midnight-glass': {
    nameVi: 'Kính nửa đêm',
    en: 'Dark glass shading from near-black to deep indigo, with a faint band of light and a bright edge.',
    vi: 'Kính tối chuyển từ gần đen sang chàm đậm, có dải sáng mờ và viền sáng.',
  },
  'curated:soft-lavender': {
    nameVi: 'Oải hương dịu',
    en: 'Frosted glass with a soft lavender tint.',
    vi: 'Kính mờ phủ sắc oải hương dịu.',
  },
  'curated:clean-paper': {
    nameVi: 'Giấy sạch',
    en: 'Warm paper-toned card with a fine fibre grain.',
    vi: 'Thẻ màu giấy ấm với vân sợi mịn.',
  },
  'curated:floating-card': {
    nameVi: 'Thẻ nổi',
    en: 'Near-opaque card with a wide, soft shadow that makes it look like it hovers.',
    vi: 'Thẻ gần như đặc, bóng đổ rộng và mềm khiến thẻ trông như đang lơ lửng.',
  },
  'curated:pastel-gradient': {
    nameVi: 'Gradient pastel',
    en: 'Frosted glass with a soft gradient from pale blue to lilac; deeper and quieter in a dark theme.',
    vi: 'Kính mờ với dải màu pastel từ xanh nhạt sang tím nhạt; trầm và dịu hơn ở giao diện tối.',
  },
  'curated:silk': {
    nameVi: 'Lụa',
    en: 'Smooth glass with a silvery-blue gradient, a still diagonal band of light and a bright edge.',
    vi: 'Kính mịn với dải màu xanh bạc, một dải sáng chéo đứng yên và viền sáng.',
  },
  'curated:minimal-white': {
    nameVi: 'Trắng tối giản',
    en: 'Flat white card with a hairline border and no texture.',
    vi: 'Thẻ trắng phẳng, viền mảnh, không có họa tiết.',
  },
  'curated:minimal-black': {
    nameVi: 'Đen tối giản',
    en: 'Flat pure-black card with a hairline border and no texture.',
    vi: 'Thẻ đen tuyền phẳng, viền mảnh, không có họa tiết.',
  },
  'curated:soft-glow': {
    nameVi: 'Quầng sáng dịu',
    en: 'Frosted dark glass with a blue aura that slowly breathes around it.',
    vi: 'Kính mờ tối với quầng sáng xanh chậm rãi phập phồng quanh thẻ.',
  },
}

/** A scene's name is the part of its title before the colon ("Ocean: jellyfish, fish..." is "Ocean"). */
const sceneName = (title: string): string => (title.split(':')[0] ?? title).trim()

/** The name and the one-line description of a card in the studio's language (a card of the person's own keeps what they wrote). */
export function cardLabel(
  card: Pick<OpeningCardDefinition, 'id' | 'name' | 'description' | 'sceneId'>,
  lang: string,
): { name: string; description: string } {
  const vi = lang === 'vi'
  const sceneText = card.sceneId ? SCENE_TEXT[card.sceneId] : undefined
  if (sceneText && card.sceneId) {
    const meta = sceneMeta(card.sceneId)
    return {
      name: sceneName(vi ? meta.vi : meta.en),
      description: vi ? sceneText.vi : sceneText.en,
    }
  }
  const material = MATERIAL_TEXT[card.id]
  if (material) {
    return {
      name: vi ? material.nameVi : card.name,
      description: vi ? material.vi : material.en,
    }
  }
  return { name: card.name, description: card.description ?? '' }
}
