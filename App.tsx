import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Layer, ToolType, SelectionBox, AIAnalysisResult, Point } from './types';
import { Icons } from './components/Icon';
import { analyzeImageContents, generativeImageEdit, detectSubject } from './services/geminiService';

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 800;

export default function App() {
  // State
  const [layers, setLayers] = useState<Layer[]>([]);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [currentTool, setCurrentTool] = useState<ToolType>(ToolType.MOVE);
  
  // History State
  const [history, setHistory] = useState<Layer[][]>([[]]);
  const [historyIndex, setHistoryIndex] = useState(0);

  // Selection States
  const [selection, setSelection] = useState<SelectionBox | null>(null);
  const [selectionPoly, setSelectionPoly] = useState<Point[] | null>(null);
  const [magicEraserStrokes, setMagicEraserStrokes] = useState<Point[][]>([]);
  const [currentMagicEraserStroke, setCurrentMagicEraserStroke] = useState<Point[]>([]);
  
  // Interaction States
  const [isDragging, setIsDragging] = useState(false);
  const [startPoint, setStartPoint] = useState<{x: number, y: number} | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  // AI States
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiResult, setAiResult] = useState<AIAnalysisResult | null>(null);
  
  // Brush State
  const [brushColor, setBrushColor] = useState('#ffffff');
  const [brushSize, setBrushSize] = useState(5);
  const [currentStroke, setCurrentStroke] = useState<Point[]>([]);

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const noiseCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const activeLayer = layers.find(l => l.id === activeLayerId);

  // --- Initialization ---

  const uid = () => Math.random().toString(36).substring(2, 9);

  // Create Noise Pattern Once
  useEffect(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 200;
      const ctx = canvas.getContext('2d');
      if(ctx) {
          const idata = ctx.createImageData(200, 200);
          const buffer32 = new Uint32Array(idata.data.buffer);
          for(let i = 0; i < buffer32.length; i++) {
             const val = (Math.random() * 255) | 0;
             buffer32[i] = (val << 24) | (val << 16) | (val << 8) | val; 
          }
          ctx.putImageData(idata, 0, 0);
          noiseCanvasRef.current = canvas;
      }
  }, []);

  // --- History Management ---

  const addToHistory = (newLayers: Layer[]) => {
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push(newLayers);
      // Optional: Limit history size to 20 steps to save memory
      if (newHistory.length > 20) newHistory.shift();
      
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
  };

  const handleUndo = () => {
      if (historyIndex > 0) {
          const newIndex = historyIndex - 1;
          setHistoryIndex(newIndex);
          setLayers(history[newIndex]);
      }
  };

  const handleRedo = () => {
      if (historyIndex < history.length - 1) {
          const newIndex = historyIndex + 1;
          setHistoryIndex(newIndex);
          setLayers(history[newIndex]);
      }
  };

  // Keyboard Shortcuts for Undo/Redo
  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
              e.preventDefault();
              if (e.shiftKey) {
                  handleRedo();
              } else {
                  handleUndo();
              }
          }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
              e.preventDefault();
              handleRedo();
          }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [history, historyIndex]);

  // --- Layer Hierarchy Helpers ---

  // Check if a layer and all its parents are visible
  const isLayerVisible = useCallback((layerId: string, allLayers: Layer[]) => {
      let current = allLayers.find(l => l.id === layerId);
      while (current) {
          if (!current.visible) return false;
          if (current.parentId) {
              current = allLayers.find(l => l.id === current?.parentId);
          } else {
              break;
          }
      }
      return true;
  }, []);
  
  // --- Canvas Rendering ---
  
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw checkerboard
    const checkSize = 20;
    for (let y = 0; y < canvas.height; y += checkSize) {
      for (let x = 0; x < canvas.width; x += checkSize) {
        ctx.fillStyle = (x / checkSize + y / checkSize) % 2 === 0 ? '#2d3748' : '#1a202c';
        ctx.fillRect(x, y, checkSize, checkSize);
      }
    }

    // Render layers from bottom (0) to top (n)
    [...layers].reverse().forEach(layer => {
      // Skip groups themselves for rendering content (they are just containers)
      if (layer.type === 'group') return;

      // Check visibility including parents
      if (!isLayerVisible(layer.id, layers)) return;

      ctx.save();
      
      // 1. Masking
      if (layer.mask && layer.mask.length > 0) {
          ctx.beginPath();
          const mx = layer.mask[0].x + layer.x;
          const my = layer.mask[0].y + layer.y;
          ctx.moveTo(mx, my);
          layer.mask.forEach(p => ctx.lineTo(p.x + layer.x, p.y + layer.y));
          ctx.closePath();
          ctx.clip();
      }

      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = layer.blendMode as GlobalCompositeOperation;
      
      // 2. Transformations
      const centerX = layer.x + layer.width / 2;
      const centerY = layer.y + layer.height / 2;
      
      ctx.translate(centerX, centerY);
      ctx.rotate((layer.rotation * Math.PI) / 180);
      ctx.scale(layer.scaleX, layer.scaleY);
      ctx.translate(-centerX, -centerY);

      // 3. Standard Filters
      const f = layer.filters;
      const effBrightness = f.brightness + f.exposure;
      
      const filterString = `brightness(${effBrightness}%) contrast(${f.contrast}%) grayscale(${f.grayscale}%) blur(${f.blur}px) sepia(${f.sepia}%) saturate(${f.saturate}%) hue-rotate(${f.hueRotate}deg)`;
      ctx.filter = filterString;

      // 4. Draw Content
      if (layer.type === 'image' && layer.imgElement) {
        ctx.drawImage(layer.imgElement, layer.x, layer.y, layer.width, layer.height);
      } else if (layer.type === 'text' && layer.text) {
        ctx.font = `${layer.fontSize}px ${layer.fontFamily || 'sans-serif'}`;
        ctx.fillStyle = layer.color || 'white';
        ctx.fillText(layer.text, layer.x, layer.y + (layer.fontSize || 20));
      } else if (layer.type === 'brush_stroke' && layer.strokes) {
        // Render completed strokes
        layer.strokes.forEach(stroke => {
            ctx.beginPath();
            ctx.strokeStyle = stroke.color;
            ctx.lineWidth = stroke.size;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            if (stroke.points.length > 0) {
                ctx.moveTo(stroke.points[0].x + layer.x, stroke.points[0].y + layer.y);
                stroke.points.forEach(p => ctx.lineTo(p.x + layer.x, p.y + layer.y));
            }
            ctx.stroke();
        });

        // Render current stroke
        if (layer.id === activeLayerId && currentStroke.length > 0) {
             ctx.beginPath();
             ctx.strokeStyle = brushColor;
             ctx.lineWidth = brushSize;
             ctx.lineCap = 'round';
             ctx.lineJoin = 'round';
             ctx.moveTo(currentStroke[0].x + layer.x, currentStroke[0].y + layer.y);
             currentStroke.forEach(p => ctx.lineTo(p.x + layer.x, p.y + layer.y));
             ctx.stroke();
        }
      }

      // 5. Advanced Filters
      ctx.filter = 'none';

      if (f.temperature !== 0) {
          ctx.save();
          ctx.globalCompositeOperation = f.temperature > 0 ? 'overlay' : 'soft-light';
          const color = f.temperature > 0 
             ? `rgba(255, 160, 0, ${Math.abs(f.temperature) / 150})`
             : `rgba(0, 100, 255, ${Math.abs(f.temperature) / 150})`;
          ctx.fillStyle = color;
          ctx.fillRect(layer.x, layer.y, layer.width, layer.height);
          ctx.restore();
      }

      if (f.tint !== 0) {
          ctx.save();
          ctx.globalCompositeOperation = 'overlay';
          const color = f.tint > 0 
             ? `rgba(255, 0, 255, ${Math.abs(f.tint) / 150})` 
             : `rgba(0, 255, 0, ${Math.abs(f.tint) / 150})`;  
          ctx.fillStyle = color;
          ctx.fillRect(layer.x, layer.y, layer.width, layer.height);
          ctx.restore();
      }

      if (f.vignette > 0) {
          ctx.save();
          ctx.globalCompositeOperation = 'source-over'; 
          const grad = ctx.createRadialGradient(centerX, centerY, Math.max(layer.width, layer.height) * 0.3, centerX, centerY, Math.max(layer.width, layer.height) * 0.8);
          grad.addColorStop(0, 'rgba(0,0,0,0)');
          grad.addColorStop(1, `rgba(0,0,0, ${f.vignette / 100})`);
          ctx.fillStyle = grad;
          ctx.fillRect(layer.x, layer.y, layer.width, layer.height);
          ctx.restore();
      }

      if (f.grain && f.grain > 0 && noiseCanvasRef.current) {
          ctx.save();
          ctx.globalCompositeOperation = 'overlay';
          ctx.globalAlpha = (f.grain / 100) * 0.5;
          const pattern = ctx.createPattern(noiseCanvasRef.current, 'repeat');
          if (pattern) {
              ctx.fillStyle = pattern;
              ctx.fillRect(layer.x, layer.y, layer.width, layer.height);
          }
          ctx.restore();
      }
      
      ctx.restore();
    });

    // Overlays (Selection, Tools)
    if (selection) {
      ctx.save();
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(selection.startX, selection.startY, selection.width, selection.height);
      ctx.fillStyle = 'rgba(0,255,0,0.1)';
      ctx.fillRect(selection.startX, selection.startY, selection.width, selection.height);
      ctx.restore();
    }

    if (selectionPoly && selectionPoly.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(selectionPoly[0].x, selectionPoly[0].y);
        selectionPoly.forEach(p => ctx.lineTo(p.x, p.y));
        if (currentTool !== ToolType.LASSO || !isDragging) {
            ctx.closePath();
        }
        ctx.stroke();
        ctx.fillStyle = 'rgba(0, 255, 0, 0.1)';
        ctx.fill();
        ctx.restore();
    }

    if (currentTool === ToolType.MAGIC_ERASER) {
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = brushSize;
        ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
        magicEraserStrokes.forEach(stroke => {
            if(stroke.length > 0) {
                ctx.beginPath();
                ctx.moveTo(stroke[0].x, stroke[0].y);
                stroke.forEach(p => ctx.lineTo(p.x, p.y));
                ctx.stroke();
            }
        });
        if (currentMagicEraserStroke.length > 0) {
            ctx.beginPath();
            ctx.moveTo(currentMagicEraserStroke[0].x, currentMagicEraserStroke[0].y);
            currentMagicEraserStroke.forEach(p => ctx.lineTo(p.x, p.y));
            ctx.stroke();
        }
        ctx.restore();
    }

  }, [layers, selection, selectionPoly, currentStroke, activeLayerId, brushColor, brushSize, currentTool, isDragging, magicEraserStrokes, currentMagicEraserStroke, isLayerVisible]);

  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  // --- Actions ---

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        
        if (width > CANVAS_WIDTH * 0.8) {
            const ratio = (CANVAS_WIDTH * 0.8) / width;
            width *= ratio;
            height *= ratio;
        }

        const newLayer: Layer = {
          id: uid(),
          name: `Layer ${layers.length + 1}`,
          type: 'image',
          isSmartObject: true,
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: 'normal',
          imgElement: img,
          x: (CANVAS_WIDTH - width) / 2,
          y: (CANVAS_HEIGHT - height) / 2,
          width: width,
          height: height,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          filters: {
            brightness: 100, contrast: 100, blur: 0, grayscale: 0, sepia: 0, saturate: 100, hueRotate: 0,
            temperature: 0, tint: 0, exposure: 0, vignette: 0, grain: 0
          }
        };
        const newLayers = [newLayer, ...layers];
        setLayers(newLayers);
        setActiveLayerId(newLayer.id);
        addToHistory(newLayers);
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleDownload = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const tempSelection = selection;
    const tempPoly = selectionPoly;
    const tempEraser = magicEraserStrokes;
    const tempTool = currentTool;

    setSelection(null);
    setSelectionPoly(null);
    setMagicEraserStrokes([]);
    setCurrentTool(ToolType.MOVE);
    
    setTimeout(() => {
      const link = document.createElement('a');
      link.download = 'edited-image.png';
      link.href = canvas.toDataURL('image/png');
      link.click();
      setSelection(tempSelection);
      setSelectionPoly(tempPoly);
      setMagicEraserStrokes(tempEraser);
      setCurrentTool(tempTool);
    }, 50);
  };

  // --- Layer Management (Groups, Lock, Hierarchy) ---

  const handleCreateGroup = () => {
      const newGroup: Layer = {
          id: uid(),
          name: `Group ${layers.filter(l => l.type === 'group').length + 1}`,
          type: 'group',
          visible: true, locked: false, opacity: 1, blendMode: 'normal',
          x: 0, y: 0, width: 0, height: 0,
          rotation: 0, scaleX: 1, scaleY: 1, collapsed: false,
          filters: { brightness: 100, contrast: 100, blur: 0, grayscale: 0, sepia: 0, saturate: 100, hueRotate: 0, temperature: 0, tint: 0, exposure: 0, vignette: 0, grain: 0 }
      };
      const newLayers = [newGroup, ...layers];
      setLayers(newLayers);
      setActiveLayerId(newGroup.id);
      addToHistory(newLayers);
  };

  const handleToggleLock = () => {
      if (!activeLayerId) return;
      const newLayers = layers.map(l => l.id === activeLayerId ? { ...l, locked: !l.locked } : l);
      setLayers(newLayers);
      addToHistory(newLayers);
  };
  
  const handleRotate = () => {
      if (!activeLayerId) return;
      const newLayers = layers.map(l => l.id === activeLayerId ? {...l, rotation: (l.rotation + 90) % 360} : l);
      setLayers(newLayers);
      addToHistory(newLayers);
  };

  const handleScale = (factor: number) => {
    if (!activeLayerId || activeLayer?.locked) return;
    const newLayers = layers.map(l => {
        if (l.id === activeLayerId) {
            return { ...l, scaleX: l.scaleX * factor, scaleY: l.scaleY * factor };
        }
        return l;
    });
    setLayers(newLayers);
    addToHistory(newLayers);
  };

  const updateLayerScale = (val: number) => {
      if (!activeLayerId || activeLayer?.locked) return;
      const newLayers = layers.map(l => {
          if (l.id === activeLayerId) {
              return { ...l, scaleX: val, scaleY: val };
          }
          return l;
      });
      setLayers(newLayers);
  };

  const updateLayerRotation = (val: number) => {
      if (!activeLayerId || activeLayer?.locked) return;
      const newLayers = layers.map(l => {
          if (l.id === activeLayerId) {
              return { ...l, rotation: val };
          }
          return l;
      });
      setLayers(newLayers);
  };

  const handleIndentLayer = () => {
      if (!activeLayerId) return;
      const idx = layers.findIndex(l => l.id === activeLayerId);
      if (idx === -1 || idx === 0) return; 

      const prevLayer = layers[idx - 1];
      let newLayers = [...layers];
      if (prevLayer.type === 'group') {
          newLayers = layers.map(l => l.id === activeLayerId ? { ...l, parentId: prevLayer.id } : l);
      } else if (prevLayer.parentId) {
          newLayers = layers.map(l => l.id === activeLayerId ? { ...l, parentId: prevLayer.parentId } : l);
      } else {
          return; // No change
      }
      setLayers(newLayers);
      addToHistory(newLayers);
  };

  const handleOutdentLayer = () => {
      if (!activeLayerId || !activeLayer?.parentId) return;
      const parent = layers.find(l => l.id === activeLayer?.parentId);
      const newLayers = layers.map(l => l.id === activeLayerId ? { ...l, parentId: parent?.parentId } : l);
      setLayers(newLayers);
      addToHistory(newLayers);
  };

  // --- Tool Handlers ---

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeLayer?.locked && currentTool !== ToolType.SELECT_RECT && currentTool !== ToolType.LASSO) {
        return; // Block interaction on locked layer
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setIsDragging(true);
    setStartPoint({ x, y });

    if (currentTool === ToolType.DODGE || currentTool === ToolType.BURN) {
        let targetLayer = layers.find(l => l.id === activeLayerId && l.type === 'brush_stroke' && l.blendMode === 'overlay');
        if (!targetLayer) {
            const newLayer: Layer = {
                id: uid(),
                name: currentTool === ToolType.DODGE ? 'Dodge Layer' : 'Burn Layer',
                type: 'brush_stroke',
                visible: true, locked: false, opacity: 1, blendMode: 'overlay',
                x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT,
                rotation: 0, scaleX: 1, scaleY: 1,
                filters: { brightness: 100, contrast: 100, blur: 0, grayscale: 0, sepia: 0, saturate: 100, hueRotate: 0, temperature: 0, tint: 0, exposure: 0, vignette: 0, grain: 0 },
                strokes: []
            };
            setLayers([newLayer, ...layers]);
            setActiveLayerId(newLayer.id);
        } else if (activeLayerId !== targetLayer.id) {
            setActiveLayerId(targetLayer.id);
        }
        const color = currentTool === ToolType.DODGE ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';
        setBrushColor(color);
        setCurrentStroke([{x, y}]);
        return;
    } else if (currentTool === ToolType.BRUSH) {
        let targetLayer = layers.find(l => l.id === activeLayerId);
        if (!targetLayer || targetLayer.type !== 'brush_stroke' || targetLayer.blendMode === 'overlay') {
            const newLayer: Layer = {
                id: uid(),
                name: `Brush Layer ${layers.length + 1}`,
                type: 'brush_stroke',
                visible: true, locked: false, opacity: 1, blendMode: 'normal',
                x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT,
                rotation: 0, scaleX: 1, scaleY: 1,
                filters: { brightness: 100, contrast: 100, blur: 0, grayscale: 0, sepia: 0, saturate: 100, hueRotate: 0, temperature: 0, tint: 0, exposure: 0, vignette: 0, grain: 0 },
                strokes: []
            };
            setLayers([newLayer, ...layers]);
            setActiveLayerId(newLayer.id);
            targetLayer = newLayer;
        }
        const lx = x - targetLayer.x;
        const ly = y - targetLayer.y;
        setCurrentStroke([{x: lx, y: ly}]);
    } else if (currentTool === ToolType.MAGIC_ERASER) {
        setCurrentMagicEraserStroke([{x, y}]);
    } else if (currentTool === ToolType.LASSO) {
        setSelection(null); 
        setSelectionPoly([{x, y}]); 
    } else if (currentTool === ToolType.SELECT_RECT || currentTool === ToolType.AI_FILL) {
        setSelectionPoly(null);
        setSelection({ startX: x, startY: y, width: 0, height: 0 });
    } else if (currentTool === ToolType.TEXT) {
         const newLayer: Layer = {
            id: uid(),
            name: `Text Layer`,
            type: 'text',
            text: "New Text",
            fontSize: 48,
            color: '#ffffff',
            visible: true, locked: false, opacity: 1, blendMode: 'normal',
            x: x, y: y, width: 200, height: 50,
            rotation: 0, scaleX: 1, scaleY: 1,
            filters: { brightness: 100, contrast: 100, blur: 0, grayscale: 0, sepia: 0, saturate: 100, hueRotate: 0, temperature: 0, tint: 0, exposure: 0, vignette: 0, grain: 0 }
        };
        const newLayers = [newLayer, ...layers];
        setLayers(newLayers);
        setActiveLayerId(newLayer.id);
        addToHistory(newLayers);
        setIsDragging(false);
        setCurrentTool(ToolType.MOVE);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeLayer?.locked && isDragging && currentTool === ToolType.MOVE) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if ((currentTool === ToolType.BRUSH || currentTool === ToolType.DODGE || currentTool === ToolType.BURN) && isDragging) {
        const layer = layers.find(l => l.id === activeLayerId);
        const lx = x - (layer?.x || 0);
        const ly = y - (layer?.y || 0);
        setCurrentStroke(prev => [...prev, {x: lx, y: ly}]);
        return;
    }

    if (currentTool === ToolType.MAGIC_ERASER && isDragging) {
        setCurrentMagicEraserStroke(prev => [...prev, {x, y}]);
        return;
    }

    if (currentTool === ToolType.LASSO && isDragging) {
        setSelectionPoly(prev => prev ? [...prev, {x, y}] : [{x, y}]);
        return;
    }

    if (!isDragging || !startPoint) return;
    const dx = x - startPoint.x;
    const dy = y - startPoint.y;

    if ((currentTool === ToolType.SELECT_RECT || currentTool === ToolType.AI_FILL) && selection) {
      setSelection({
        ...selection,
        width: x - selection.startX,
        height: y - selection.startY
      });
    } else if (currentTool === ToolType.MOVE && activeLayer && !activeLayer.locked) {
      const updatedLayers = layers.map(l => {
        if (l.id === activeLayerId) {
          return { ...l, x: l.x + dx, y: l.y + dy };
        }
        return l;
      });
      setLayers(updatedLayers);
      setStartPoint({ x, y });
    }
  };

  const handleMouseUp = () => {
    if ((currentTool === ToolType.BRUSH || currentTool === ToolType.DODGE || currentTool === ToolType.BURN) && isDragging && currentStroke.length > 0 && activeLayerId) {
        let strokeColor = brushColor;
        if (currentTool === ToolType.DODGE) strokeColor = 'rgba(255,255,255,0.05)'; 
        if (currentTool === ToolType.BURN) strokeColor = 'rgba(0,0,0,0.05)';

        const newLayers = layers.map(l => {
            if (l.id === activeLayerId && l.type === 'brush_stroke') {
                return {
                    ...l,
                    strokes: [...(l.strokes || []), { points: currentStroke, color: strokeColor, size: brushSize }]
                };
            }
            return l;
        });
        setLayers(newLayers);
        addToHistory(newLayers);
        setCurrentStroke([]);
    }
    
    if (currentTool === ToolType.MAGIC_ERASER && isDragging && currentMagicEraserStroke.length > 0) {
        setMagicEraserStrokes(prev => [...prev, currentMagicEraserStroke]);
        setCurrentMagicEraserStroke([]);
    }

    if (currentTool === ToolType.MOVE && isDragging && startPoint && activeLayer) {
        // If significant movement occurred, save history
        const dx = Math.abs(startPoint.x - (activeLayer.x - (activeLayer.x - (startPoint.x - activeLayer.x)))); // simplified check, just always save on drag end if moved
        addToHistory(layers);
    }

    setIsDragging(false);
    setStartPoint(null);
  };

  // --- Modifications ---

  const updateLayerFilter = (key: keyof Layer['filters'], value: number) => {
    if (!activeLayerId || activeLayer?.locked) return;
    setLayers(layers.map(l => {
      if (l.id === activeLayerId) {
        return { ...l, filters: { ...l.filters, [key]: value } };
      }
      return l;
    }));
  };

  const updateTextLayer = (key: keyof Layer, value: any) => {
      if (!activeLayerId || activeLayer?.locked) return;
      setLayers(layers.map(l => l.id === activeLayerId ? { ...l, [key]: value } : l));
  };

  const handleCreateMask = () => {
      if (!activeLayer || activeLayer.locked || (!selection && !selectionPoly)) return;
      
      let maskPoints: Point[] = [];
      if (selectionPoly) {
          maskPoints = selectionPoly.map(p => ({ x: p.x - activeLayer.x, y: p.y - activeLayer.y }));
      } else if (selection) {
          const { startX, startY, width, height } = selection;
          maskPoints = [
             { x: startX, y: startY }, { x: startX + width, y: startY },
             { x: startX + width, y: startY + height }, { x: startX, y: startY + height }
          ].map(p => ({ x: p.x - activeLayer.x, y: p.y - activeLayer.y }));
      }
      const newLayers = layers.map(l => l.id === activeLayerId ? { ...l, mask: maskPoints } : l);
      setLayers(newLayers);
      addToHistory(newLayers);
      setSelection(null); setSelectionPoly(null); setCurrentTool(ToolType.MOVE);
  };

  const handleDeleteMask = () => {
      if (!activeLayerId || activeLayer?.locked) return;
      const newLayers = layers.map(l => l.id === activeLayerId ? { ...l, mask: undefined } : l);
      setLayers(newLayers);
      addToHistory(newLayers);
  };

  const applyPreset = (name: string) => {
      if (!activeLayerId || activeLayer?.locked) return;
      const presets: Record<string, Partial<Layer['filters']>> = {
          'Vintage': { sepia: 60, contrast: 120, brightness: 110, vignette: 40, temperature: 20, grain: 30 },
          'Noir': { grayscale: 100, contrast: 140, brightness: 100, vignette: 60, exposure: 10, grain: 50 },
          'Warm': { temperature: 40, saturate: 120, contrast: 105 },
          'Cool': { temperature: -30, tint: 10, brightness: 105 },
          'Cinematic': { contrast: 130, saturate: 80, temperature: -10, vignette: 30, grain: 10 }
      };
      const p = presets[name];
      if (!p) return;
      const newLayers = layers.map(l => l.id === activeLayerId ? { ...l, filters: { ...l.filters, ...p } } : l);
      setLayers(newLayers);
      addToHistory(newLayers);
  };

  // --- AI Features ---
  const handleFaceScan = async () => {
    if (!canvasRef.current) return;
    setIsLoading(true);
    try {
      const base64 = canvasRef.current.toDataURL('image/png');
      const result = await analyzeImageContents(base64, "Detect faces. Return concise locations/expressions.");
      setAiResult({ text: result, type: 'face_scan' });
    } catch (err) {
      setAiResult({ text: "Error scanning faces.", type: 'face_scan' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectSubject = async () => {
    if (!canvasRef.current) return;
    setIsLoading(true);
    setSelection(null); setSelectionPoly(null);
    try {
        const base64 = canvasRef.current.toDataURL('image/png');
        const box = await detectSubject(base64);
        if (box) {
            setSelection({ startX: box.x * CANVAS_WIDTH, startY: box.y * CANVAS_HEIGHT, width: box.w * CANVAS_WIDTH, height: box.h * CANVAS_HEIGHT });
            setCurrentTool(ToolType.SELECT_RECT); 
        } else {
            alert("No subject found.");
        }
    } catch(err) {
        alert("AI detection error.");
    } finally {
        setIsLoading(false);
    }
  };

  const handleGenerativeFill = async () => {
    if (!canvasRef.current || !aiPrompt) return;
    setIsLoading(true);
    try {
      const base64 = canvasRef.current.toDataURL('image/png');
      const newImageBase64 = await generativeImageEdit(base64, aiPrompt);
      if (newImageBase64) {
        const img = new Image();
        img.onload = () => {
             const newLayer: Layer = {
                id: uid(), name: `AI Edit: ${aiPrompt.substring(0, 8)}`, type: 'image', isSmartObject: true, visible: true, locked: false, opacity: 1, blendMode: 'normal',
                imgElement: img, x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, rotation: 0, scaleX: 1, scaleY: 1,
                filters: { brightness: 100, contrast: 100, blur: 0, grayscale: 0, sepia: 0, saturate: 100, hueRotate: 0, temperature: 0, tint: 0, exposure: 0, vignette: 0, grain: 0 }
            };
            const newLayers = [newLayer, ...layers];
            setLayers(newLayers);
            setActiveLayerId(newLayer.id);
            addToHistory(newLayers);
            setSelection(null); setCurrentTool(ToolType.MOVE);
        };
        img.src = newImageBase64;
      }
    } catch (err) { alert("AI Gen Fill Error."); } finally { setIsLoading(false); }
  };
  
  const handleMagicErase = async () => {
      if (!canvasRef.current || magicEraserStrokes.length === 0) return;
      setIsLoading(true);
      try {
          const base64 = canvasRef.current.toDataURL('image/png');
          const prompt = "Remove the object covered by the red translucent strokes. Infill the background naturally.";
          const newImageBase64 = await generativeImageEdit(base64, prompt);
          if (newImageBase64) {
              const img = new Image();
              img.onload = () => {
                  const newLayer: Layer = {
                      id: uid(), name: 'Magic Erase Result', type: 'image', isSmartObject: true, visible: true, locked: false, opacity: 1, blendMode: 'normal',
                      imgElement: img, x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, rotation: 0, scaleX: 1, scaleY: 1,
                      filters: { brightness: 100, contrast: 100, blur: 0, grayscale: 0, sepia: 0, saturate: 100, hueRotate: 0, temperature: 0, tint: 0, exposure: 0, vignette: 0, grain: 0 }
                  };
                  const newLayers = [newLayer, ...layers];
                  setLayers(newLayers);
                  setActiveLayerId(newLayer.id);
                  addToHistory(newLayers);
                  setMagicEraserStrokes([]); setCurrentTool(ToolType.MOVE);
              };
              img.src = newImageBase64;
          }
      } catch (err) { alert("Magic Erase Failed"); } finally { setIsLoading(false); }
  };

  const handleAutoEnhance = async () => {
      if (!canvasRef.current) return;
      setIsLoading(true);
      try {
          const base64 = canvasRef.current.toDataURL('image/png');
          const prompt = "Enhance this photo. Improve lighting, color balance, contrast, and sharpness for a professional look.";
          const newImageBase64 = await generativeImageEdit(base64, prompt);
          if (newImageBase64) {
             const img = new Image();
             img.onload = () => {
                  const newLayer: Layer = {
                      id: uid(), name: 'Auto Enhanced', type: 'image', isSmartObject: true, visible: true, locked: false, opacity: 1, blendMode: 'normal',
                      imgElement: img, x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, rotation: 0, scaleX: 1, scaleY: 1,
                      filters: { brightness: 100, contrast: 100, blur: 0, grayscale: 0, sepia: 0, saturate: 100, hueRotate: 0, temperature: 0, tint: 0, exposure: 0, vignette: 0, grain: 0 }
                  };
                  const newLayers = [newLayer, ...layers];
                  setLayers(newLayers);
                  setActiveLayerId(newLayer.id);
                  addToHistory(newLayers);
             };
             img.src = newImageBase64;
          }
      } catch(err) { alert("Enhance failed."); } finally { setIsLoading(false); }
  };

  // --- Recursive Layer Rendering Helper ---
  
  const renderLayerTree = (parentId: string | null = null, depth = 0) => {
      const childLayers = layers.filter(l => l.parentId === (parentId || undefined) || (parentId === null && !l.parentId));
      return childLayers.map(layer => (
          <React.Fragment key={layer.id}>
              <div 
                  onClick={() => setActiveLayerId(layer.id)}
                  className={`flex items-center p-1.5 rounded cursor-pointer select-none group ${activeLayerId === layer.id ? 'bg-blue-900/30 border border-blue-500/50' : 'hover:bg-gray-800 border border-transparent'}`}
                  style={{ marginLeft: `${depth * 16}px` }}
              >
                   {/* Group Toggle */}
                   {layer.type === 'group' && (
                       <button onClick={(e) => { e.stopPropagation(); setLayers(layers.map(l => l.id === layer.id ? { ...l, collapsed: !l.collapsed } : l)) }} className="mr-1 text-gray-400 hover:text-white">
                           {layer.collapsed ? <Icons.Folder /> : <Icons.FolderOpen />}
                       </button>
                   )}
                   {/* Visibility */}
                   <button onClick={(e) => { e.stopPropagation(); setLayers(layers.map(l => l.id === layer.id ? {...l, visible: !l.visible} : l)); }} className={`mr-2 ${layer.visible ? 'text-gray-400' : 'text-gray-700'}`}>
                        {layer.visible ? <Icons.Eye /> : <Icons.EyeOff />}
                   </button>
                   
                   {/* Icon */}
                   <div className="w-8 h-8 bg-gray-700 rounded mr-2 overflow-hidden flex items-center justify-center relative flex-shrink-0">
                         {layer.type === 'image' && layer.imgElement ? <img src={layer.imgElement.src} className="w-full h-full object-cover" /> 
                         : layer.type === 'group' ? <span className="text-gray-400"><Icons.Folder /></span>
                         : <span className="text-[10px] text-gray-400">{layer.type.substring(0,2).toUpperCase()}</span>}
                         {layer.locked && <div className="absolute top-0 right-0 bg-red-900/80 p-0.5 rounded-bl"><Icons.Lock /></div>}
                   </div>
                   
                   {/* Name */}
                   <div className="flex-1 min-w-0">
                        <div className="text-xs truncate text-gray-200">{layer.name}</div>
                        {layer.mask && <div className="text-[9px] text-green-500 flex items-center gap-1"><Icons.Mask /> Masked</div>}
                   </div>
              </div>
              {/* Recursive Children */}
              {layer.type === 'group' && !layer.collapsed && renderLayerTree(layer.id, depth + 1)}
          </React.Fragment>
      ));
  };

  return (
    <div className="flex h-screen w-screen bg-gray-950 text-gray-100 font-sans overflow-hidden">
      {/* --- Left Toolbar --- */}
      <div className="w-16 flex-shrink-0 bg-gray-900 border-r border-gray-700 flex flex-col items-center py-4 space-y-3 z-20 overflow-y-auto scrollbar-hide">
        <div className="font-bold text-blue-400 text-[10px] text-center mb-2">TOOLS</div>
        <ToolButton active={currentTool === ToolType.MOVE} onClick={() => setCurrentTool(ToolType.MOVE)} icon={<Icons.Move />} tooltip="Move (V)" />
        <ToolButton active={currentTool === ToolType.SELECT_RECT} onClick={() => setCurrentTool(ToolType.SELECT_RECT)} icon={<Icons.Select />} tooltip="Marquee (M)" />
        <ToolButton active={currentTool === ToolType.LASSO} onClick={() => setCurrentTool(ToolType.LASSO)} icon={<Icons.Lasso />} tooltip="Lasso (L)" />
        <ToolButton active={currentTool === ToolType.MAGIC_WAND} onClick={handleSelectSubject} icon={<Icons.MagicWand />} tooltip="Select Subject (AI)" />
        <div className="w-10 h-px bg-gray-700 my-1"></div>
        <ToolButton active={currentTool === ToolType.BRUSH} onClick={() => { setCurrentTool(ToolType.BRUSH); setBrushColor('#ffffff'); }} icon={<Icons.Brush />} tooltip="Brush (B)" />
        <ToolButton active={currentTool === ToolType.DODGE} onClick={() => setCurrentTool(ToolType.DODGE)} icon={<Icons.Sun />} tooltip="Dodge (Lighten)" />
        <ToolButton active={currentTool === ToolType.BURN} onClick={() => setCurrentTool(ToolType.BURN)} icon={<Icons.Moon />} tooltip="Burn (Darken)" />
        <ToolButton active={currentTool === ToolType.MAGIC_ERASER} onClick={() => setCurrentTool(ToolType.MAGIC_ERASER)} icon={<Icons.Eraser />} tooltip="Magic Eraser (AI)" color="text-red-400" />
        <div className="w-10 h-px bg-gray-700 my-1"></div>
        <ToolButton active={currentTool === ToolType.TEXT} onClick={() => setCurrentTool(ToolType.TEXT)} icon={<Icons.Text />} tooltip="Text (T)" />
        <ToolButton active={currentTool === ToolType.CROP} onClick={handleRotate} icon={<Icons.Crop />} tooltip="Rotate" />
        <div className="w-10 h-px bg-gray-700 my-1"></div>
        <ToolButton active={currentTool === ToolType.AI_FILL} onClick={() => setCurrentTool(ToolType.AI_FILL)} icon={<Icons.Magic />} tooltip="Generative Fill" color="text-purple-400" />
        <ToolButton active={currentTool === ToolType.AI_FACE} onClick={handleFaceScan} icon={<Icons.Face />} tooltip="Face Scan" color="text-pink-400" />
      </div>

      {/* --- Center Workspace --- */}
      <div className="flex-1 flex flex-col relative bg-gray-850 overflow-hidden">
        <div className="h-12 bg-gray-900 border-b border-gray-700 flex items-center justify-between px-4">
           <div className="flex items-center">
             <h1 className="font-bold text-md tracking-wide text-white mr-4">AI EDITOR <span className="text-[10px] text-blue-500 border border-blue-500 px-1 rounded ml-1">PRO</span></h1>
             {(selection || selectionPoly) && (
                 <button onClick={handleCreateMask} className="flex items-center gap-2 text-xs bg-gray-800 hover:bg-gray-700 px-3 py-1 rounded border border-gray-600">
                     <Icons.Mask /> Mask Selection
                 </button>
             )}
             <button onClick={handleAutoEnhance} className="ml-3 flex items-center gap-2 text-xs bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 px-3 py-1 rounded font-bold text-white shadow-md transition-all">
                 <Icons.Sparkles /> Auto Enhance
             </button>
           </div>
           <div className="flex space-x-2 items-center">
             <div className="flex mr-4 space-x-1">
                 <button onClick={handleUndo} className={`p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white ${historyIndex <= 0 ? 'opacity-30 cursor-not-allowed' : ''}`} title="Undo (Ctrl+Z)"><Icons.Undo /></button>
                 <button onClick={handleRedo} className={`p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white ${historyIndex >= history.length - 1 ? 'opacity-30 cursor-not-allowed' : ''}`} title="Redo (Ctrl+Y)"><Icons.Redo /></button>
             </div>
             <input type="file" ref={fileInputRef} onChange={handleUpload} className="hidden" accept="image/*" />
             <button onClick={() => fileInputRef.current?.click()} className="flex items-center space-x-1 bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded text-xs border border-gray-600 transition">
               <Icons.Upload /> <span>Open</span>
             </button>
             <button onClick={handleDownload} className="flex items-center space-x-1 bg-blue-700 hover:bg-blue-600 px-3 py-1.5 rounded text-xs font-medium transition">
               <Icons.Download /> <span>Export</span>
             </button>
           </div>
        </div>

        <div className="flex-1 overflow-auto flex items-center justify-center p-8 relative bg-[#1e1e1e]">
           <canvas 
             ref={canvasRef}
             width={CANVAS_WIDTH}
             height={CANVAS_HEIGHT}
             className={`shadow-2xl border border-gray-700 bg-[url('https://media.istockphoto.com/id/1222357475/vector/image-transparent-background-photoshop-grid-vector-illustration.jpg?s=612x612&w=0&k=20&c=O9BqEa748Aiw9gX4C8B_510U5T-dK9vW3HkCg_6QOVI=')] bg-contain ${activeLayer?.locked ? 'cursor-not-allowed' : ''}`}
             style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', cursor: activeLayer?.locked ? 'not-allowed' : (currentTool === ToolType.MOVE ? 'move' : 'crosshair') }}
             onMouseDown={handleMouseDown}
             onMouseMove={handleMouseMove}
             onMouseUp={handleMouseUp}
             onMouseLeave={handleMouseUp}
           />
           {isLoading && (
             <div className="absolute inset-0 bg-black bg-opacity-60 flex flex-col items-center justify-center z-50">
                <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-2"></div>
                <p className="text-blue-400 text-xs font-mono animate-pulse">AI Processing...</p>
             </div>
           )}
           {aiResult && (
             <div className="absolute bottom-4 left-4 bg-gray-900/90 border border-gray-600 p-4 rounded shadow-lg max-w-md z-40">
                <div className="flex justify-between mb-2"><h3 className="font-bold text-xs uppercase text-purple-400">AI Analysis</h3><button onClick={() => setAiResult(null)}>✕</button></div>
                <p className="text-xs text-gray-300">{aiResult.text}</p>
             </div>
           )}
        </div>
      </div>

      {/* --- Right Properties Panel --- */}
      <div className="w-80 bg-gray-900 border-l border-gray-700 flex flex-col flex-shrink-0 z-20 text-sm">
        <div className="p-3 border-b border-gray-700 bg-gray-850">
            <h2 className="font-bold text-xs uppercase text-gray-400 flex items-center gap-2">
                {activeLayer?.type === 'text' ? <><Icons.Text /> TEXT EDITOR</> : activeLayer?.type === 'group' ? <><Icons.Folder /> GROUP PROPERTIES</> : <><Icons.Sliders /> PROPERTIES</>}
            </h2>
        </div>

        {currentTool === ToolType.AI_FILL && (
            <div className="p-4 bg-indigo-900/10 border-b border-gray-700">
                <p className="text-[10px] font-bold text-purple-400 mb-2 uppercase">Generative Fill</p>
                <textarea value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} placeholder="Describe changes..." className="w-full bg-gray-800 border border-gray-600 rounded p-2 text-xs text-white mb-2 h-16" />
                <button onClick={handleGenerativeFill} className="w-full bg-purple-600 hover:bg-purple-500 py-1.5 rounded text-xs font-bold">Generate</button>
            </div>
        )}

        {currentTool === ToolType.MAGIC_ERASER && (
             <div className="p-4 bg-red-900/10 border-b border-gray-700">
                <p className="text-[10px] font-bold text-red-400 mb-2 uppercase flex items-center gap-2"><Icons.Eraser /> Magic Eraser</p>
                <p className="text-[10px] text-gray-400 mb-3">Paint over objects to remove them using AI.</p>
                <div className="flex justify-between items-center mb-3">
                    <span className="text-xs text-gray-400">Brush Size</span>
                    <input type="range" min={5} max={50} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} className="w-24 h-1 bg-gray-700 rounded accent-red-500" />
                </div>
                <div className="flex gap-2">
                    <button onClick={() => setMagicEraserStrokes([])} className="flex-1 bg-gray-700 hover:bg-gray-600 py-1.5 rounded text-xs">Clear</button>
                    <button onClick={handleMagicErase} className="flex-1 bg-red-600 hover:bg-red-500 py-1.5 rounded text-xs font-bold text-white">Remove Object</button>
                </div>
             </div>
        )}

        {(currentTool === ToolType.BRUSH || currentTool === ToolType.DODGE || currentTool === ToolType.BURN) && (
            <div className="p-4 border-b border-gray-700">
                <div className="flex justify-between mb-2">
                    <span className="text-xs text-gray-400">Brush Size: {brushSize}px</span>
                </div>
                <input type="range" min={1} max={100} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} className="w-full h-1 bg-gray-700 rounded mb-3 accent-blue-500" />
                {currentTool === ToolType.BRUSH && (
                     <div className="flex items-center gap-2"><input type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} className="w-6 h-6 bg-transparent border-none" /><span className="text-xs text-gray-400">{brushColor}</span></div>
                )}
            </div>
        )}

        {/* Properties List */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
           {!activeLayer ? (
               <div className="p-8 text-center text-gray-600 text-xs italic">Select a layer to edit properties</div>
           ) : activeLayer.type === 'text' && !activeLayer.locked ? (
               <div className="p-4 space-y-4">
                   <div>
                       <label className="block text-xs text-gray-400 mb-1">Content</label>
                       <textarea value={activeLayer.text || ''} onChange={(e) => updateTextLayer('text', e.target.value)} onBlur={() => addToHistory(layers)} className="w-full bg-gray-800 border border-gray-600 rounded p-2 text-sm h-20" />
                   </div>
                   <div>
                       <label className="block text-xs text-gray-400 mb-1">Size: {activeLayer.fontSize}px</label>
                       <input type="range" min={12} max={200} value={activeLayer.fontSize} onChange={(e) => updateTextLayer('fontSize', Number(e.target.value))} onMouseUp={() => addToHistory(layers)} className="w-full h-1 bg-gray-700 rounded accent-blue-500" />
                   </div>
                   <div>
                       <label className="block text-xs text-gray-400 mb-1">Color</label>
                       <div className="flex gap-2 items-center">
                           <input type="color" value={activeLayer.color} onChange={(e) => updateTextLayer('color', e.target.value)} onBlur={() => addToHistory(layers)} className="w-8 h-8 bg-transparent cursor-pointer" />
                           <span className="text-xs text-gray-500">{activeLayer.color}</span>
                       </div>
                   </div>
               </div>
           ) : activeLayer.type === 'group' ? (
               <div className="p-4 text-center text-gray-500 text-xs">Group selected. <br/>Properties affect children in rendering (Opacity/Blend).</div>
           ) : !activeLayer.locked && (
               <div className="p-4 space-y-6">
                   <div>
                       <h3 className="text-[10px] font-bold text-blue-400 uppercase mb-3 flex items-center gap-1"><Icons.Crop /> Transform</h3>
                       <div className="space-y-3">
                           <div className="flex items-center justify-between">
                               <label className="text-[10px] text-gray-400">Scale</label>
                               <div className="flex gap-2">
                                   <button onClick={() => handleScale(1.1)} className="p-1 bg-gray-700 rounded hover:bg-gray-600"><Icons.ZoomIn /></button>
                                   <button onClick={() => handleScale(0.9)} className="p-1 bg-gray-700 rounded hover:bg-gray-600"><Icons.ZoomOut /></button>
                               </div>
                           </div>
                           <input type="range" min={0.1} max={3} step={0.1} value={activeLayer.scaleX} onChange={(e) => updateLayerScale(parseFloat(e.target.value))} onMouseUp={() => addToHistory(layers)} className="w-full h-1 bg-gray-700 rounded appearance-none cursor-pointer accent-blue-500" />
                           
                           <div className="flex justify-between mt-2">
                               <label className="text-[10px] text-gray-400">Rotation: {Math.round(activeLayer.rotation)}°</label>
                           </div>
                           <input type="range" min={0} max={360} value={activeLayer.rotation} onChange={(e) => updateLayerRotation(parseInt(e.target.value))} onMouseUp={() => addToHistory(layers)} className="w-full h-1 bg-gray-700 rounded appearance-none cursor-pointer accent-blue-500" />
                       </div>
                   </div>

                   <div className="border-t border-gray-800 pt-4">
                       <h3 className="text-[10px] font-bold text-blue-400 uppercase mb-3 flex items-center gap-1"><Icons.Sliders /> Camera Raw</h3>
                       <div className="space-y-3">
                           <Control label="Temperature" value={activeLayer.filters.temperature} min={-100} max={100} onChange={(v) => updateLayerFilter('temperature', v)} onCommit={() => addToHistory(layers)} color="text-orange-300" />
                           <Control label="Tint" value={activeLayer.filters.tint} min={-100} max={100} onChange={(v) => updateLayerFilter('tint', v)} onCommit={() => addToHistory(layers)} color="text-pink-300" />
                           <Control label="Exposure" value={activeLayer.filters.exposure} min={-100} max={100} onChange={(v) => updateLayerFilter('exposure', v)} onCommit={() => addToHistory(layers)} />
                           <Control label="Vignette" value={activeLayer.filters.vignette} min={0} max={100} onChange={(v) => updateLayerFilter('vignette', v)} onCommit={() => addToHistory(layers)} />
                           <div className="pt-1">
                               <div className="flex justify-between mb-1">
                                   <label className="text-[10px] text-gray-400 flex items-center gap-1"><Icons.Grain /> Grain</label>
                                   <span className="text-[10px] text-gray-500 font-mono">{Math.round(activeLayer.filters.grain)}</span>
                               </div>
                               <input type="range" min={0} max={100} value={activeLayer.filters.grain} onChange={(e) => updateLayerFilter('grain', parseFloat(e.target.value))} onMouseUp={() => addToHistory(layers)} className="w-full h-1 bg-gray-700 rounded appearance-none cursor-pointer accent-gray-400" />
                           </div>
                       </div>
                   </div>
                   <div className="border-t border-gray-800 pt-4">
                       <h3 className="text-[10px] font-bold text-gray-500 uppercase mb-3">Basic Tone</h3>
                       <div className="space-y-3">
                           <Control label="Contrast" value={activeLayer.filters.contrast} min={0} max={200} onChange={(v) => updateLayerFilter('contrast', v)} onCommit={() => addToHistory(layers)} />
                           <Control label="Brightness" value={activeLayer.filters.brightness} min={0} max={200} onChange={(v) => updateLayerFilter('brightness', v)} onCommit={() => addToHistory(layers)} />
                           <Control label="Saturation" value={activeLayer.filters.saturate} min={0} max={200} onChange={(v) => updateLayerFilter('saturate', v)} onCommit={() => addToHistory(layers)} />
                           <Control label="Blur" value={activeLayer.filters.blur} min={0} max={50} onChange={(v) => updateLayerFilter('blur', v)} onCommit={() => addToHistory(layers)} />
                       </div>
                   </div>
                   <div className="border-t border-gray-800 pt-4">
                        <h3 className="text-[10px] font-bold text-gray-500 uppercase mb-3">Effect Presets</h3>
                        <div className="grid grid-cols-3 gap-2">
                           {['Vintage', 'Noir', 'Warm', 'Cool', 'Cinematic'].map(p => (
                               <button key={p} onClick={() => applyPreset(p)} className="bg-gray-800 hover:bg-gray-700 py-1.5 rounded text-[10px] border border-gray-600 transition">{p}</button>
                           ))}
                        </div>
                   </div>
               </div>
           )}
        </div>

        {/* Layers Panel */}
        <div className="h-1/2 border-t border-gray-700 bg-gray-850 flex flex-col">
            <div className="p-2 bg-gray-900 border-b border-gray-700 flex justify-between items-center">
                <span className="text-[10px] font-bold text-gray-400 uppercase flex items-center gap-1"><Icons.Layers /> Layers</span>
                <div className="flex gap-2">
                     <button onClick={handleCreateGroup} className="text-gray-400 hover:text-white" title="New Group"><Icons.Folder /></button>
                     <button onClick={handleIndentLayer} className="text-gray-400 hover:text-white" title="Move into Group"><Icons.Indent /></button>
                     <button onClick={handleOutdentLayer} className="text-gray-400 hover:text-white" title="Move out of Group"><Icons.Outdent /></button>
                     <div className="w-px h-4 bg-gray-700 mx-1"></div>
                     <button onClick={handleToggleLock} className={`${activeLayer?.locked ? 'text-red-400' : 'text-gray-400'} hover:text-white`} title="Lock/Unlock"><Icons.Lock /></button>
                     <button onClick={() => {if(activeLayerId) handleDeleteMask()}} className="text-xs text-gray-500 hover:text-white px-1" title="Remove Mask"><Icons.Mask /></button>
                     <button onClick={() => { 
                         if(activeLayerId && confirm('Delete?')) {
                             const newLayers = layers.filter(l => l.id !== activeLayerId);
                             setLayers(newLayers);
                             addToHistory(newLayers);
                         } 
                     }} className="text-gray-600 hover:text-red-400 px-1"><Icons.Trash /></button>
                </div>
            </div>
            <div className="flex-1 overflow-y-auto p-1 space-y-1">
                {renderLayerTree(null)}
            </div>
        </div>
      </div>
    </div>
  );
}

const ToolButton = ({ active, onClick, icon, tooltip, color }: { active: boolean, onClick: () => void, icon: React.ReactNode, tooltip: string, color?: string }) => (
    <div className="relative group w-full flex justify-center">
        <button onClick={onClick} className={`p-2.5 rounded-lg transition-all duration-200 ${active ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'} ${color && !active ? color : ''}`}>
            {icon}
        </button>
        <span className="absolute left-14 top-1/2 -translate-y-1/2 bg-black text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap transition-opacity z-50 border border-gray-700 shadow-xl">
            {tooltip}
        </span>
    </div>
);

const Control = ({ label, value, min, max, onChange, onCommit, color }: { label: string, value: number, min: number, max: number, onChange: (v: number) => void, onCommit: () => void, color?: string }) => (
    <div className="mb-1">
        <div className="flex justify-between mb-1">
            <label className={`text-[10px] ${color || 'text-gray-400'}`}>{label}</label>
            <span className="text-[10px] text-gray-500 font-mono">{Math.round(value)}</span>
        </div>
        <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} onMouseUp={onCommit} className="w-full h-1 bg-gray-700 rounded appearance-none cursor-pointer accent-blue-500" />
    </div>
);