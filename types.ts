
export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  points: Point[];
  color: string;
  size: number;
}

export interface Layer {
  id: string;
  name: string;
  type: 'image' | 'text' | 'brush_stroke' | 'group'; // Added 'group'
  visible: boolean;
  locked: boolean;
  opacity: number; // 0 to 1
  blendMode: string;
  isSmartObject?: boolean; 
  
  // Grouping
  parentId?: string | null;
  collapsed?: boolean;

  // Image specific
  imgElement?: HTMLImageElement;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // degrees
  scaleX: number; // for flip
  scaleY: number;

  // Filter data (Non-destructive)
  filters: {
    brightness: number; // 100 is default
    contrast: number; // 100 is default
    blur: number; // 0 is default
    grayscale: number; // 0 to 100
    sepia: number; // 0 to 100
    saturate: number; // 100 default
    hueRotate: number; // 0 default
    
    // Camera Raw / Advanced
    temperature: number; // -100 to 100 (Warmth)
    tint: number; // -100 to 100 (Green/Magenta)
    exposure: number; // -100 to 100
    vignette: number; // 0 to 100
    grain: number; // 0 to 100
  };

  // Text specific
  text?: string;
  color?: string;
  fontSize?: number;
  fontFamily?: string;

  // Brush specific
  strokes?: Stroke[];

  // Selection/Masking
  mask?: Point[]; // Polygon points relative to layer or global
}

export enum ToolType {
  MOVE = 'MOVE',
  SELECT_RECT = 'SELECT_RECT',
  LASSO = 'LASSO',
  MAGIC_WAND = 'MAGIC_WAND',
  BRUSH = 'BRUSH',
  TEXT = 'TEXT',
  CROP = 'CROP',
  AI_FILL = 'AI_FILL',
  AI_FACE = 'AI_FACE',
  DODGE = 'DODGE',
  BURN = 'BURN',
  MAGIC_ERASER = 'MAGIC_ERASER'
}

export interface SelectionBox {
  startX: number;
  startY: number;
  width: number;
  height: number;
}

export interface AIAnalysisResult {
  text: string;
  type: 'face_scan' | 'general';
}
