'use strict';

const previewDelay = .35;
const poseEdges = [[0,1],[0,2],[1,3],[2,4],[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]];

function drawRecognition(ctx, packet, width, height) {
  if (!packet) return;
  ctx.lineWidth = Math.max(2, width / 420);
  ctx.font = Math.max(12, width / 55) + 'px "Microsoft YaHei", sans-serif';
  if (packet.region_percent) {
    const part = packet.region_percent / 100;
    ctx.strokeStyle = '#6bd6b2';
    ctx.strokeRect(width * (1 - part) / 2, height * (1 - part) / 2, width * part, height * part);
  }
  for (const points of packet.poses || []) {
    ctx.strokeStyle = '#67d8ae';
    ctx.beginPath();
    for (const [a,b] of poseEdges) {
      if (!points[a] || !points[b]) continue;
      ctx.moveTo(points[a][0] * width, points[a][1] * height);
      ctx.lineTo(points[b][0] * width, points[b][1] * height);
    }
    ctx.stroke();
    ctx.fillStyle = '#70dbba';
    for (const point of points) {
      if (!point) continue;
      ctx.beginPath();
      ctx.arc(point[0] * width, point[1] * height, ctx.lineWidth, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (const [i,[left,top,right,bottom,score]] of (packet.boxes || []).entries()) {
    const x = left * width, y = top * height;
    ctx.strokeStyle = '#5da9ff';
    ctx.strokeRect(x, y, (right - left) * width, (bottom - top) * height);
    const posture = packet.postures?.[i];
    const label = (posture && posture !== '姿态不确定' ? posture : '人员') + ' ' + Math.round(score * 100) + '%';
    const labelWidth = ctx.measureText(label).width + 9;
    const labelLeft = Math.min(x, Math.max(0, width - labelWidth));
    const labelTop = Math.max(0, y - 21);
    ctx.fillStyle = '#195696';
    ctx.fillRect(labelLeft, labelTop, labelWidth, 21);
    ctx.fillStyle = 'white';
    ctx.fillText(label, labelLeft + 4, labelTop + 15);
  }
  const action = packet.findings.find(item => item.type === 'fall') ||
      packet.findings.find(item => item.type === 'eating');
  if (action) {
    const label = action.type === 'fall' || action.pose === '疑似饮用' ? action.pose : '疑似进食';
    ctx.fillStyle = '#272219';
    ctx.fillRect(8, 8, 91, 25);
    ctx.fillStyle = '#ffd76e';
    ctx.fillText(label, 14, 26);
  }
}

class FileMotionPreview {
  constructor(source, playback, isPaused, onFailure) {
    this.playback = playback;
    this.abort = new AbortController();
    this.onFailure = onFailure;
    this.isPaused = isPaused;
    this.frames = [];
    this.video = document.createElement('video');
    this.video.className = 'preview-decoder';
    this.video.setAttribute('aria-hidden', 'true');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.loop = true;
    this.surfaces = [source, source + '-result'].map(id => {
      const canvas = document.getElementById('motion-' + id);
      return {
        id, canvas, ctx: canvas.getContext('2d', {alpha:false}),
        still: document.getElementById('image-' + id),
        stamp: document.getElementById('stamp-' + id),
      };
    });
  }

  open(file) {
    if (this.abort.signal.aborted) return;
    const video = this.video;
    this.url = URL.createObjectURL(file);
    video.addEventListener('error', () => this.onFailure(), {once:true});
    video.addEventListener('loadedmetadata', () => {
      this.align();
      video.play().then(() => this.scheduleDraw()).catch(() => this.onFailure());
    }, {once:true});
    document.body.append(video);
    video.src = this.url;
  }

  addPacket(packet) {
    if (!Number.isFinite(packet?.video_time) || this.frames.at(-1)?.frame_id === packet.frame_id) return;
    // Retain metadata only. The page stops requesting JPEGs once playback starts.
    const {raw,result,...metadata} = packet;
    this.frames.push(metadata);
    if (this.frames.length > 32) this.frames.shift();
    this.align();
  }

  align() {
    const latest = this.frames.at(-1);
    const video = this.video;
    if (!latest || !Number.isFinite(video.duration) || video.duration <= 0) return;
    this.head = Math.max(0, latest.video_loop * video.duration + latest.video_time - previewDelay);
    const current = this.mediaPosition(video.currentTime);
    const error = this.head - current;
    if (!this.aligned || Math.abs(error) > .8) {
      video.currentTime = this.head % video.duration;
      video.playbackRate = 1;
      this.aligned = true;
    } else {
      video.playbackRate = 1 + Math.max(-.075, Math.min(.075, error * .26));
    }
  }

  mediaPosition(mediaTime) {
    if (!Number.isFinite(this.head)) return mediaTime;
    return this.video.duration * Math.max(0, Math.round((this.head - mediaTime) / this.video.duration)) + mediaTime;
  }

  scheduleDraw() {
    if (this.abort.signal.aborted) return;
    if (this.video.requestVideoFrameCallback) {
      this.callback = this.video.requestVideoFrameCallback((_, frame) => {
        this.draw(frame.mediaTime);
        this.scheduleDraw();
      });
    } else {
      this.callback = requestAnimationFrame(() => {
        this.draw(this.video.currentTime);
        this.scheduleDraw();
      });
    }
  }

  draw(mediaTime) {
    const video = this.video;
    if (video.readyState < 2 || mediaTime === this.lastTime) return;
    this.lastTime = mediaTime;
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale);
    const elapsed = this.mediaPosition(mediaTime);
    const packet = this.frames.findLast(item => {
      const age = elapsed - (item.video_loop * video.duration + item.video_time);
      return age >= -.018 && age <= .43;
    });
    this.ready = true;
    for (const [index, surface] of this.surfaces.entries()) {
      const {id, canvas, ctx, still, stamp} = surface;
      if (this.isPaused(id)) continue;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.drawImage(video, 0, 0, width, height);
      if (index) drawRecognition(ctx, packet, width, height);
      canvas.dataset.time = mediaTime.toFixed(4);
      if (index) canvas.dataset.detectionFrame = packet?.frame_id ?? '';
      const label = index ? (packet ? '识别帧 ' + packet.frame_id : '等待对应识别结果') : '原片播放';
      if (stamp.textContent !== label) stamp.textContent = label;
      canvas.hidden = false;
      still.hidden = true;
    }
  }

  close(preserve = false) {
    this.abort.abort();
    this.ready = false;
    if (this.callback !== undefined) {
      if (this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.callback);
      else cancelAnimationFrame(this.callback);
    }
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
    if (this.url) URL.revokeObjectURL(this.url);
    if (preserve) return;
    for (const {canvas,still} of this.surfaces) {
      canvas.hidden = true;
      if (still.getAttribute('src')) still.hidden = false;
    }
  }
}
