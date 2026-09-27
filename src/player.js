const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mediaState(video) {
  // Read player state; seeking and speed changes use the player's controls.
  return video.evaluate((element) => ({
    currentTime: element.currentTime,
    duration: element.duration,
    paused: element.paused,
    ended: element.ended,
    muted: element.muted,
    volume: element.volume,
    playbackRate: element.playbackRate,
    readyState: element.readyState,
  }));
}

async function playerFrameFor(container) {
  const iframe = container.locator('iframe.ans-insertvideo-online').first();
  await iframe.waitFor({ state: 'attached', timeout: 30000 });
  const handle = await iframe.elementHandle();
  const frame = await handle.contentFrame();
  if (!frame) throw new Error('视频播放器框架尚未加载。');
  return frame;
}

async function hoverControls(frame) {
  const player = frame.locator('.video-js').first();
  if (await player.count()) await player.hover({ timeout: 10000 });
}

async function dismissNoteHint(frame) {
  const hint = frame.locator('.writeNote_vid_con').first();
  if (!await hint.count()) return;
  const displayed = await hint.evaluate((element) => getComputedStyle(element).display !== 'none');
  if (displayed) await frame.locator('.writeNote_vid_blue').first().dispatchEvent('click');
}

async function clickPlayerControl(locator) {
  // The site's control bar compresses some buttons to 2 px and a note hint
  // can cover them. Trigger the real UI control's click handler directly.
  await locator.dispatchEvent('click');
}

async function setMuteThroughControls(frame, video) {
  const before = await mediaState(video);
  if (before.muted || before.volume === 0) return;
  await hoverControls(frame);
  const mute = frame.locator('.vjs-mute-control').first();
  await clickPlayerControl(mute);
  const after = await mediaState(video);
  if (!after.muted && after.volume !== 0) throw new Error('已点击静音控件，但播放器仍有声音。');
}

async function setDoubleSpeedThroughControls(frame, video) {
  const before = await mediaState(video);
  if (Math.abs(before.playbackRate - 2) < 0.01) return;
  await hoverControls(frame);
  await clickPlayerControl(frame.locator('.vjs-playback-rate button').first());
  const option = frame.locator('.vjs-playback-rate .vjs-menu-item').filter({ hasText: /^2x$/i }).first();
  await clickPlayerControl(option);
  const after = await mediaState(video);
  if (Math.abs(after.playbackRate - 2) >= 0.01) throw new Error('已选择界面上的 2×，但播放器未切换到 2×。');
}

async function clickPlayPause(frame) {
  await hoverControls(frame);
  await clickPlayerControl(frame.locator('.vjs-play-control').first());
}

async function startThroughControls(frame) {
  const bigPlay = frame.locator('.vjs-big-play-button').first();
  if (await bigPlay.isVisible()) {
    await bigPlay.click({ timeout: 10000 });
  } else {
    await clickPlayPause(frame);
  }
}

async function seekNearEndThroughControls(frame, video, report, label) {
  const before = await mediaState(video);
  if (!Number.isFinite(before.duration) || before.duration <= 0) throw new Error('播放器没有提供有效时长，无法使用进度条。');
  if (before.ended || before.duration - before.currentTime <= 4) return;
  const progress = frame.locator('.vjs-progress-control').first();
  await progress.waitFor({ state: 'visible', timeout: 15000 });
  const box = await progress.boundingBox();
  if (!box || box.width < 50 || box.height < 2) throw new Error('播放器进度条不可操作。');
  const x = Math.max(1, Math.min(box.width - 2, box.width * (1 - 2 / before.duration)));
  await progress.click({ position: { x, y: box.height / 2 }, timeout: 15000 });

  let after;
  const deadline = Date.now() + 5000;
  do {
    after = await mediaState(video);
    if (after.ended || after.duration - after.currentTime <= 15) break;
    await sleep(250);
  } while (Date.now() < deadline);
  report.log('video_seek_via_progress_bar', {
    label,
    fromSeconds: Math.round(before.currentTime),
    toSeconds: Math.round(after.currentTime),
    durationSeconds: Math.round(after.duration),
  });
  if (!after.ended && after.duration - after.currentTime > 15) throw new Error('已点击进度条末尾，但视频没有跳到接近结束的位置。');
}

async function restartFromBeginningThroughControls(frame, video, report, label) {
  const slider = frame.locator('.vjs-progress-holder').first();
  await slider.waitFor({ state: 'attached', timeout: 15000 });
  const box = await slider.evaluate((element) => element.getBoundingClientRect().toJSON());
  if (box.width < 50 || box.height < 1) throw new Error('播放器进度条不可操作，无法从头重播。');
  const event = { clientX: box.left + 1, clientY: box.top + Math.max(1, box.height / 2), button: 0, bubbles: true };
  // The left directory can cover the bar. Send mouse events to the player's
  // own slider so its normal seek handler moves playback to the beginning.
  await slider.dispatchEvent('mousedown', { ...event, buttons: 1 });
  await slider.dispatchEvent('mouseup', { ...event, buttons: 0 });
  await slider.dispatchEvent('click', { ...event, buttons: 0 });
  const state = await mediaState(video);
  if (state.currentTime > 3) throw new Error('已点击进度条开头，但视频没有回到起点。');
  report.log('video_restart_from_beginning', { label, positionSeconds: Math.round(state.currentTime) });
}

async function pauseActiveVideo(active) {
  if (!active?.frame || !active?.video) return;
  try {
    const state = await mediaState(active.video);
    if (!state.paused && !state.ended) await clickPlayPause(active.frame);
  } catch {
    // The page may have navigated while stopping. The report still records the stop.
  }
}

async function playVideo(container, controller, report, label, mode = 'seek') {
  if (!['seek', 'natural'].includes(mode)) throw new Error(`未知视频模式：${mode}`);
  let frame = await playerFrameFor(container);
  let video = frame.locator('video').first();
  await video.waitFor({ state: 'attached', timeout: 45000 });
  controller.active = { frame, video };
  let state = await mediaState(video);
  report.log('video_loaded', {
    label,
    mode,
    resumedAtSeconds: Math.round(state.currentTime || 0),
    durationSeconds: Number.isFinite(state.duration) ? Math.round(state.duration) : null,
  });
  if (state.ended && mode === 'seek') {
    controller.active = null;
    return { status: 'already_ended', method: 'seek', durationSeconds: state.duration };
  }

  await dismissNoteHint(frame);
  await setMuteThroughControls(frame, video);
  await setDoubleSpeedThroughControls(frame, video);

  if (mode === 'natural') {
    await restartFromBeginningThroughControls(frame, video, report, label);
    state = await mediaState(video);
  }

  if (state.paused) {
    await startThroughControls(frame);
    frame = await playerFrameFor(container);
    video = frame.locator('video').first();
    await video.waitFor({ state: 'attached', timeout: 30000 });
    controller.active = { frame, video };
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      state = await mediaState(video);
      if (!state.paused || state.ended) break;
      await sleep(500);
    }
    if (state.paused && !state.ended) throw new Error('已点击页面播放按钮，但视频未开始。');
  }
  await dismissNoteHint(frame);
  await setMuteThroughControls(frame, video);
  await setDoubleSpeedThroughControls(frame, video);
  state = await mediaState(video);
  if (state.paused && !state.ended) throw new Error('设置静音或倍速后视频意外暂停。');

  let method = mode === 'natural' ? 'natural' : 'seek';
  if (mode === 'seek' && !controller.stopping) {
    const beforeSeek = await mediaState(video);
    try {
      await seekNearEndThroughControls(frame, video, report, label);
    } catch (error) {
      report.log('video_seek_unavailable', { label, message: error.message });
      method = 'natural';
      frame = await playerFrameFor(container);
      video = frame.locator('video').first();
      controller.active = { frame, video };
      const afterSeek = await mediaState(video);
      if (afterSeek.currentTime > beforeSeek.currentTime + 5) {
        await restartFromBeginningThroughControls(frame, video, report, label);
      }
    }
  }
  state = await mediaState(video);
  if (state.paused && !state.ended && !controller.stopping) await clickPlayPause(frame);

  let lastProgressAt = Date.now();
  let lastPosition = state.currentTime || 0;
  let lastLogAt = 0;
  while (!controller.stopping) {
    await sleep(1000);
    state = await mediaState(video);
    if (state.ended) {
      report.log('video_ended', { label, method, durationSeconds: Math.round(state.duration || 0) });
      controller.active = null;
      return { status: method === 'seek' ? 'ended_after_seek' : 'ended_naturally', method, durationSeconds: state.duration };
    }
    if (state.currentTime > lastPosition + 0.15) {
      lastPosition = state.currentTime;
      lastProgressAt = Date.now();
    }
    if (Date.now() - lastLogAt >= 30000) {
      report.log('video_progress', {
        label,
        currentSeconds: Math.round(state.currentTime || 0),
        durationSeconds: Number.isFinite(state.duration) ? Math.round(state.duration) : null,
        paused: state.paused,
      });
      lastLogAt = Date.now();
    }
    if (state.paused && Date.now() - lastProgressAt > 15000) throw new Error('视频意外暂停，可能需要人工处理。');
    if (Math.abs(state.playbackRate - 2) >= 0.01) throw new Error('播放器倍速发生变化，已停止当前视频。');
    if (!state.muted && state.volume !== 0) throw new Error('播放器不再静音，已停止当前视频。');
    if (Date.now() - lastProgressAt > controller.stallMs) throw new Error('视频播放进度长时间未变化。');
  }
  await pauseActiveVideo(controller.active);
  controller.active = null;
  return { status: 'stopped', durationSeconds: state.duration };
}

module.exports = { playVideo, pauseActiveVideo };
