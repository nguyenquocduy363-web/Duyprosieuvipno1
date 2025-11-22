import { GoogleGenAI } from "@google/genai";

// Ensure API key is present
const apiKey = process.env.API_KEY || '';
const ai = new GoogleGenAI({ apiKey });

// Helper to convert base64 to raw format if needed, though Gemini SDK handles inlineData well.
const stripBase64Prefix = (base64: string) => {
  return base64.replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, '');
};

export const analyzeImageContents = async (base64Image: string, prompt: string): Promise<string> => {
  try {
    const cleanBase64 = stripBase64Prefix(base64Image);
    
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash', // Good for multimodal analysis
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: cleanBase64
            }
          },
          { text: prompt }
        ]
      }
    });

    return response.text || "Không thể phân tích ảnh.";
  } catch (error) {
    console.error("AI Analysis Error:", error);
    return "Lỗi kết nối AI. Vui lòng kiểm tra API Key.";
  }
};

export const detectSubject = async (base64Image: string): Promise<{x: number, y: number, w: number, h: number} | null> => {
  try {
    const cleanBase64 = stripBase64Prefix(base64Image);
    
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [
          { inlineData: { mimeType: 'image/png', data: cleanBase64 } },
          { text: "Detect the bounding box of the main single subject in this image. Return ONLY a JSON object with keys 'ymin', 'xmin', 'ymax', 'xmax' where values are integers from 0 to 100 representing the percentage of the image dimensions. Do not include Markdown formatting." }
        ]
      }
    });

    const text = response.text?.replace(/```json|```/g, '').trim();
    if (!text) return null;
    
    const json = JSON.parse(text);
    if (json.xmin !== undefined) {
        // Convert percentage to standard normalized 0-1 rect for the caller to scale
        return {
            x: json.xmin / 100,
            y: json.ymin / 100,
            w: (json.xmax - json.xmin) / 100,
            h: (json.ymax - json.ymin) / 100
        };
    }
    return null;
  } catch (error) {
    console.error("Detect Subject Error:", error);
    return null;
  }
};

export const generativeImageEdit = async (
  base64Image: string, 
  prompt: string
): Promise<string | null> => {
  try {
    const cleanBase64 = stripBase64Prefix(base64Image);

    // Using gemini-2.5-flash-image or gemini-3-pro-image-preview for generation/editing
    // The prompt implies an editing task.
    // We construct a prompt that asks the model to act as an image generator based on the input.
    
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image', 
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: cleanBase64
            }
          },
          { text: `Edit this image: ${prompt}. Return only the image.` }
        ]
      }
    });

    // Extract image from response
    // Note: The response structure for image generation usually involves looking at parts
    const parts = response.candidates?.[0]?.content?.parts;
    if (parts) {
        for (const part of parts) {
            if (part.inlineData && part.inlineData.data) {
                return `data:image/png;base64,${part.inlineData.data}`;
            }
        }
    }
    
    // Fallback if no image found directly
    return null;

  } catch (error) {
    console.error("Generative Edit Error:", error);
    throw error;
  }
};
