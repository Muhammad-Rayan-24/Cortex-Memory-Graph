import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js?module';

export class Viewer {
  constructor(opts) {
    const { maxPoints, fogColor = 0x0f1021, clusters = [], bounds } = opts;
    this.maxPoints = maxPoints;
    this.clusters = clusters;
    this.bounds = bounds;
    this.onHover = null;
    this.onSelect = null;
    this.onViewChanged = null;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(fogColor, 0.0012);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 4000);
    this.camera.position.set(260, 140, 560);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    document.body.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enableZoom = true;
    this.controls.enablePan = true;
    this.controls.zoomSpeed = 1.0;
    this.controls.panSpeed = 0.6;
    this.controls.rotateSpeed = 0.6;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 20;
    this.controls.maxDistance = 3000;

    // Starfield background
    this._addStars();

    // Points geometry and material
    this.positions = new Float32Array(this.maxPoints * 3);
    this.colors = new Float32Array(this.maxPoints * 3);
    this.clusterIds = new Uint8Array(this.maxPoints);
    this.count = 0;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.PointsMaterial({ size: 3.0, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 1.0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.points = new THREE.Points(this.geometry, this.material);
    this.scene.add(this.points);

    // Connection lines (LOD limited)
    this.lineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.5, depthTest: true, blending: THREE.AdditiveBlending });
    this.lineGeometry = new THREE.BufferGeometry();
    this.lines = new THREE.LineSegments(this.lineGeometry, this.lineMaterial);
    this.scene.add(this.lines);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points.threshold = 8; // px picking radius
    this.mouse = new THREE.Vector2();

    this._bindEvents();
    this._tick();
  }

  _addStars() {
    const starCount = 2000;
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 1200 * (0.7 + Math.random()*0.3);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2*Math.random() - 1);
      starPositions[i*3] = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
      starPositions[i*3+2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const mat = new THREE.PointsMaterial({ color: 0x6b7280, size: 1.0, sizeAttenuation: true, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending });
    this.stars = new THREE.Points(geo, mat);
    this.scene.add(this.stars);
  }

  _bindEvents() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    const scheduleViewChanged = () => {
      if (this.onViewChanged) this.onViewChanged();
    };
    this.controls.addEventListener('change', scheduleViewChanged);

    window.addEventListener('mousemove', (e) => {
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
      const hit = this._pick();
      if (this.onHover) this.onHover(hit);
    });

    window.addEventListener('click', () => {
      const hit = this._pick();
      if (this.onSelect) this.onSelect(hit);
    });
  }

  _pick() {
    if (this.count === 0) return null;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObject(this.points);
    if (!intersects.length) return null;
    const i = intersects[0].index;
    const x = this.positions[i*3], y = this.positions[i*3+1], z = this.positions[i*3+2];
    return { index: i, clusterId: this.clusterIds[i], position: new THREE.Vector3(x,y,z) };
  }

  updatePoints(count, positions, colors, clusterIds) {
    const n = Math.min(count, this.maxPoints);
    this.positions.set(positions.subarray(0, n*3), 0);
    this.colors.set(colors.subarray(0, n*3), 0);
    this.clusterIds.set(clusterIds.subarray(0, n), 0);
    this.count = n;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.setDrawRange(0, n);
  }

  updateLines(segmentCount, positions, colors) {
    if (!segmentCount || !positions) {
      // clear
      this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
      if (this.lineGeometry.getAttribute('color')) {
        this.lineGeometry.deleteAttribute('color');
      }
      this.lineGeometry.setDrawRange(0, 0);
      return;
    }
    const attr = new THREE.BufferAttribute(positions, 3);
    this.lineGeometry.setAttribute('position', attr);
    if (colors) {
      const cAttr = new THREE.BufferAttribute(colors, 3);
      this.lineGeometry.setAttribute('color', cAttr);
    } else if (this.lineGeometry.getAttribute('color')) {
      this.lineGeometry.deleteAttribute('color');
    }
    this.lineGeometry.setDrawRange(0, segmentCount * 2); // vertices = segments * 2
    this.lineGeometry.attributes.position.needsUpdate = true;
    if (this.lineGeometry.getAttribute('color')) this.lineGeometry.attributes.color.needsUpdate = true;
  }

  setMaxPoints(newMax) {
    if (newMax === this.maxPoints) return;
    this.maxPoints = newMax;
    // Reallocate CPU arrays
    this.positions = new Float32Array(newMax * 3);
    this.colors = new Float32Array(newMax * 3);
    this.clusterIds = new Uint8Array(newMax);
    // Dispose old geometry and create a new one to match capacity
    if (this.points) this.points.geometry.dispose();
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setDrawRange(0, 0);
    this.points.geometry = geom;
    this.geometry = geom;
    this.count = 0;
    // Clear lines when budget changes; worker will refill
    this.updateLines(0, null);
  }

  getCameraState() {
    return {
      position: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
      proj: this.camera.projectionMatrix.elements.slice(),
      view: this.camera.matrixWorldInverse.elements.slice(),
      viewport: [window.innerWidth, window.innerHeight]
    };
  }

  resetView() {
    this.controls.target.set(0,0,0);
    this.camera.position.set(260, 140, 560);
    this.controls.update();
    if (this.onViewChanged) this.onViewChanged();
  }

  _tick() {
    requestAnimationFrame(() => this._tick());
    this.controls.update();
    this.stars.rotation.y += 0.00035;
    this.stars.rotation.x += 0.00012;
    this.renderer.render(this.scene, this.camera);
  }
}
