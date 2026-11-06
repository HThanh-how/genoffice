import type {
  LiveBackgroundReason,
  LiveBackgroundState,
} from '../../../shared/fork/live-background'

/** Copy for the live-background Settings card (fork-only; English is the fallback for every other language). */
const COPY = {
  en: {
    group: 'Background',
    groupHint: 'A picture or a muted looping video behind the Home screen. Off by default.',
    show: 'Live background',
    showHint: 'Uses the file where it is. Nothing is copied into GenOffice.',
    chooseFile: 'Choose picture or video…',
    chooseFolder: 'Choose folder…',
    clear: 'Clear source',
    source: 'Source',
    none: 'Nothing chosen yet',
    folderHint:
      'A folder of pictures/videos, or a Wallpaper Engine folder (steamapps/workshop/content/431960). Only video items play.',
    item: 'Item',
    itemOf: (i: number, n: number) => `${i} of ${n}`,
    skipped: (n: number) => `${n} not playable here (scene / web / application) skipped`,
    prev: 'Previous',
    next: 'Next',
    dim: 'Overlay strength',
    dimHint: 'Tints the picture with the theme colour so text stays readable.',
    blur: 'Blur',
    blurHint: 'Soft focus helps readability but costs graphics power on large videos.',
    saver: 'Battery / GPU saver',
    saverHint: 'Pauses the video when the window loses focus or the computer runs on battery.',
    wallpaperEngine: 'Wallpaper Engine item',
    status: {
      missing: 'The chosen file or folder is no longer there.',
      empty: 'No playable picture or video was found in that folder.',
      'no-source': 'Choose a picture, a video or a folder to start.',
    },
    reasons: {
      'we-scene':
        'This Wallpaper Engine item is a "scene" (scene.pkg / .tex), a format only Wallpaper Engine can render. Pick a "video" item instead.',
      'we-application':
        'This Wallpaper Engine item is an "application" wallpaper (an .exe), which cannot run behind GenOffice.',
      'we-web':
        'This Wallpaper Engine item is a "web" wallpaper. It needs Wallpaper Engine\'s own scripting interface (wallpaperPropertyListener), which GenOffice does not provide.',
      'we-unknown': 'This Wallpaper Engine item has a type GenOffice does not know.',
      'we-invalid': 'This Wallpaper Engine item has no usable video file in its project.json.',
      'file-type': 'That file is not a picture (jpg, png, gif, webp) or a video (mp4, webm).',
    } satisfies Record<LiveBackgroundReason, string>,
    stillUsed: 'Its preview picture is used as a still background instead.',
  },
  vi: {
    group: 'Hình nền',
    groupHint: 'Ảnh hoặc video lặp, không tiếng, phía sau màn hình chính. Mặc định tắt.',
    show: 'Nền động',
    showHint: 'Dùng tệp ngay tại chỗ, không sao chép vào GenOffice.',
    chooseFile: 'Chọn ảnh hoặc video…',
    chooseFolder: 'Chọn thư mục…',
    clear: 'Xoá nguồn',
    source: 'Nguồn',
    none: 'Chưa chọn',
    folderHint:
      'Thư mục chứa ảnh/video, hoặc thư mục Wallpaper Engine (steamapps/workshop/content/431960). Chỉ mục loại video mới phát được.',
    item: 'Mục',
    itemOf: (i: number, n: number) => `${i} / ${n}`,
    skipped: (n: number) => `Đã bỏ qua ${n} mục không phát được ở đây (scene / web / application)`,
    prev: 'Trước',
    next: 'Sau',
    dim: 'Độ phủ lớp tối',
    dimHint: 'Phủ màu nền của giao diện lên ảnh để chữ vẫn dễ đọc.',
    blur: 'Độ mờ',
    blurHint: 'Làm mờ giúp dễ đọc hơn nhưng tốn GPU với video lớn.',
    saver: 'Tiết kiệm pin / GPU',
    saverHint: 'Tạm dừng video khi cửa sổ mất focus hoặc máy đang chạy pin.',
    wallpaperEngine: 'Mục Wallpaper Engine',
    status: {
      missing: 'Tệp hoặc thư mục đã chọn không còn nữa.',
      empty: 'Không tìm thấy ảnh hay video phát được trong thư mục đó.',
      'no-source': 'Hãy chọn ảnh, video hoặc thư mục để bắt đầu.',
    },
    reasons: {
      'we-scene':
        'Mục Wallpaper Engine này thuộc loại "scene" (scene.pkg / .tex), định dạng riêng mà chỉ Wallpaper Engine vẽ được. Hãy chọn mục loại "video".',
      'we-application':
        'Mục Wallpaper Engine này thuộc loại "application" (một tệp .exe), không chạy làm nền cho GenOffice được.',
      'we-web':
        'Mục Wallpaper Engine này thuộc loại "web". Nó cần giao diện lập trình riêng của Wallpaper Engine (wallpaperPropertyListener), GenOffice không có.',
      'we-unknown': 'Mục Wallpaper Engine này thuộc loại GenOffice không nhận ra.',
      'we-invalid': 'Mục Wallpaper Engine này không có tệp video dùng được trong project.json.',
      'file-type': 'Tệp này không phải ảnh (jpg, png, gif, webp) hay video (mp4, webm).',
    } satisfies Record<LiveBackgroundReason, string>,
    stillUsed: 'Ảnh xem trước của mục này được dùng làm nền tĩnh thay thế.',
  },
}

export function liveBackgroundCopy(lang: string): typeof COPY.en {
  return lang === 'vi' ? COPY.vi : COPY.en
}

/** The one-line explanation shown under the source when the chosen item is not playing normally. */
export function liveBackgroundProblem(state: LiveBackgroundState, lang: string): string {
  const c = liveBackgroundCopy(lang)
  if (state.status === 'missing' || state.status === 'empty' || state.status === 'no-source') {
    // an empty folder that only held unplayable Wallpaper Engine items says why
    const why = state.status === 'empty' && state.reason ? ` ${c.reasons[state.reason]}` : ''
    return `${c.status[state.status]}${why}`
  }
  if (state.status === 'unsupported' && state.reason) {
    return `${c.reasons[state.reason]}${state.media ? ` ${c.stillUsed}` : ''}`
  }
  return ''
}
