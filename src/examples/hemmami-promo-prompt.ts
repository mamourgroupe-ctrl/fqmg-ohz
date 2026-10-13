export const hemmamiPromoPrompt = `
Create a premium 45-second promo for SARL HEMMAMI PLAST — food-grade plastic water tanks and SARL TAYEB PLAST PVC/HDPE pipes.

REQUIREMENTS — Duration & FPS: TOTAL 1350 frames at 30 fps (45s), MARGIN 80, TRANSITION 15 frames.
SCENE_FRAMES: logo 120, who 215, strengths 215, arwa 230, bibou 170, assil 140, pipes 190, contact 175.
TOTAL_FRAMES = sum(SCENE_FRAMES) - TRANSITION * (numScenes - 1) = 1350. Use <TransitionSeries> with linearTiming({ durationInFrames: 15 }) for every transition.

BRAND:
- Name: SARL HEMMAMI PLAST / tagline: Production de réservoirs alimentaires en plastique
- Pipes brand: SARL TAYEB PLAST / tagline: Production de tubes en PVC et PEHD
- Colors: #0EA5E9, #1565C0, #0D47A1 (blues), #1A237E, #0F1A4D (navy), #A4D233, #7CB518, #2E7D32 (lime/green), #FFFFFF — gradients: blue 135deg, navy 160deg, lime 90deg. Glass border rgba(255,255,255,0.10), shadow rgba(5,10,40,0.35).
- Fonts: Cairo (Arabic, weights 600,700,800, subsets arabic+latin) for Arabic, Montserrat (500,700,800, latin) for Latin. Use FONTS.ar / FONTS.latin pattern. Easing bezier(0.22,1,0.36,1).

ASSETS (public/assets/, all 1600x1212, use <Img src={staticFile("/assets/...")} /> with staticFile + Img from remotion, objectFit cover/contain):
- /assets/logo-hp.jpeg — round blue T/P logo (white TP monogram with green T stem, blue radial gradient, black ® badge at top-right). Circular, mask with borderRadius 50% + overflow hidden.
- /assets/catalog-1.jpeg — HEMMAMI PLAST tank catalogue page (ARWA 200L-2000L, BIBOU + HORIZONTAL 500L-1000L, ASSIL 300L-1000L) — use via Crop with Box coords from products.ts style (circle crops). For this prompt, you can use <Img src={staticFile("/assets/catalog-1.jpeg")} style={{objectFit:"cover"}} /> and animate with Ken Burns.
- /assets/catalog-2.jpeg — brochure cover with tanks collage + contacts (HEMMAMI PLAST cover) — use as cover image with zoom/pan.
- /assets/product-showcase.jpeg — TAYEB PLAST PVC technical sheet with HDPE pipe coil photo (not tanks) — contains GAMME DE PRODUCTION table (diameters 40-400, Pn6/Pn10/Pn16). Show as technical sheet on one side, pipe coil image cropped.

CONTENT (Arabic, direction rtl, fontFamily Cairo):
- ABOUT_AR: "تأسست شركة همامي بلاست سنة 2021 لتخصص صناعة الخزانات البلاستيكية الغذائية التي تحافظ على الصحة وتناسب البيئة من خلال تجربة وخبرة كبيرة عن طريق الممارسة الميدانية وتعاملها الكبير في هذا المجال ولعلمها بحاجيات المستهلك ومتطلباته دفعها هذا للتخصص في الخزانات البلاستيكية الغذائية والصحة مراعين صحة المستهلك بتوفير منتج يرقى لحاجته ويلبي متطلباته"
- STRENGTHS (4): "استخدام مواد أولية لتحافظ على صحة المستهلك وصديقة للبيئة" | "منتجات بألوان زاهية ومختلفة بجودة عالية تلبي حاجيات وأذواق المستهلك" | "مراقبة الجودة والتحسين المستمر بالإصغاء لآراء المستهلكين" | "الضمان على كافة المنتجات"
- GOALS (2): "توفير مجموعة من الخزانات بمواصفات عالمية وأحجام كبيرة وحتى العملاقة" | "تغطية كافة احتياجات الزبائن في الوطن وخارج الوطن"
- LABELS: مميزاتنا / أهدافنا / الإستعمالات / امسح للتواصل
- PIPE USES (7): مياه الشرب | الصرف الصحي | الزراعة والري | الأغذية والسوائل الصناعية | الاتصالات السلكية | الإنذار والمراقبة عن بعد | حماية الكابلات الكهربائية
- PVC TABLE: GAMME DE PRODUCTION ET DIMENSIONS DES TUBES PVC — diameters 40(+0.3),50,63,80,90(+0.4),100,110,125(+0.5),160,200,225,250(+0.7),315(+0.9),400(+1.1) — thickness per Pn6/Pn10/Pn16 as in sheets.
- CONTACTS: NABIL General Manager 0550.95.15.55 / 0661.38.36.66 g.manager.hp@gmail.com | FOUAD Responsable Commercial 0550.95.15.57 / 0698.47.29.27 r.commercial.hp@gmail.com | HOCINE Délégué Commercial 0550.95.03.25 / 0660.94.05.79 delegue.commercial.hp@gmail.com — Address: Z.A Kouinine / منطقة الشاطلات كوينين — email hemmamiplast@gmail.com — Facebook Hemmami PLAST
- SCENE PLAN:
  S1 Logo (120f): AnimatedBackground blue, Logo large with 3 pulsing rings, company name typewriter, tagline + lime wipe.
  S2 Who (215f): AnimatedBackground blue, 4 circular tank crops floating (use catalog-1), GlassCard RTL word-by-word About, lime skewed band.
  S3 Strengths (215f): Blue background + 2 grayscale tank silhouettes, Ribbon مميزاتنا lime, 4 PointRows (number in lime circle + text), Ribbon أهدافنا navy, 2 PointRows.
  S4 ARWA (230f): Range grid — 5 tanks ARWA with liter circles, dimensions.
  S5 BIBOU+HORIZONTAL (170f): 3 tanks BIBOU/HORIZONTAL grid.
  S6 ASSIL (140f): 3 tanks ASSIL grid.
  S7 Pipes (190f): Fiche Technique + PVC table (8-10 rows visible, animated entrance) + hexagonal pipe coil cropped from product-showcase (CROPS pipeCoil x172 y628 w372 h366) with zoom 1→1.12, uses chips (7) + Ribbon.
  S8 Contact (175f): Navy background, Logo pulse, 3 ContactCards (GlassCard lime), address/email/facebook, QR placeholder (25x25 decorative grid with finder patterns, scan line) + label امسح للتواصل, fadeOut last 28f.

TRANSITIONS: fade between 1-2, slide from-right 2-3, wipe from-left 3-4, fade 4-5, slide from-bottom 5-6, wipe from-top-left 6-7, fade 7-8. All timing={linearTiming({durationInFrames:15})}.

CODE RULES:
- Output ONLY code starting with "import" and ending with "};"
- Single export: export const MyAnimation = () => { ... };
- All constants INSIDE component after hooks, UPPER_SNAKE_CASE
- Use useCurrentFrame, useVideoConfig, AbsoluteFill, Sequence / TransitionSeries, interpolate, spring, Img, staticFile
- NEVER use <img>, never hardcode paths, always staticFile + Img
- Every image has Ken Burns (scale 1→1.15 via interpolate, clamp)
- Text animates (spring/enter stagger, not static)
- No placeholders ("...") — real JSX.
`;
