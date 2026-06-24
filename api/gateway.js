import { supabase } from '../lib/supabase.js'
import { uploadToGoogleDrive, getOrCreateFolder } from '../lib/gdrive.js'
// import { sendPushNotification } from '../lib/firebase.js' // Uncomment if used

export default async function handler(req, res) {

  // ===============================
  // 🌐 CORS (Ultra Fast Return)
  // ===============================
  const origin = req.headers.origin || '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST only' })

  const startTime = Date.now()

  try {
    const { action, email, password, token, ...payload } = req.body

    if (!action) throw new Error("Action is required")

    // ===============================
    // 🔐 AUTH CHECK
    // ===============================
    let userContext = null
    const publicActions = ["login", "submitInstituteRegistration"]

    if (!publicActions.includes(action)) {
      const { data: { user }, error } = await supabase.auth.getUser(token)
      if (error || !user) {
        return res.status(200).json({ authFailed: true, message: "Session expired" })
      }
      userContext = user
    }

    // ===============================
    // ⚡ HANDLERS (ULTRA FAST ROUTER)
    // ===============================
    const handlers = {

      // ===============================
      // 🔐 LOGIN
      // ===============================
      login: async () => {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error

        const { data: profile } = await supabase
          .from('users')
          .select('id, email, role, status')
          .eq('auth_user_id', data.user.id)
          .single()

        if (!profile || profile.status !== 'Active') throw new Error("Account inactive")

        return {
          success: true,
          email: profile.email,
          role: profile.role,
          token: data.session.access_token
        }
      },

      // ===============================
      // 📊 DASHBOARD (PARALLEL FETCH & CONTRACT FIXED)
      // ===============================
      getDashboardPayload: async () => {
        
        // 1. Fetch User Data with Inner Joins
        const { data: userData } = await supabase
          .from('users')
          .select('*, institutes(*), operator_profiles(*)')
          .eq('auth_user_id', userContext.id)
          .single()

        const dashRole = String(userData.role).trim().toLowerCase()
        const userId = userData.id
        const instId = userData.institute_id

        // 2. Setup Privacy Queries
        let papersQuery = supabase.from('jobs_queue').select('*').eq('job_type', 'Paper')
        let docsQuery = supabase.from('jobs_queue').select('*').neq('job_type', 'Paper')

        if (dashRole === 'teacher') {
          papersQuery = papersQuery.eq('requester_id', userId)
          docsQuery = docsQuery.eq('requester_id', userId)
        } else if (dashRole === 'admin') {
          papersQuery = papersQuery.eq('institute_id', instId)
          docsQuery = docsQuery.eq('institute_id', instId)
        } else if (dashRole === 'operator') {
          papersQuery = papersQuery.eq('operator_id', userId)
          docsQuery = docsQuery.eq('operator_id', userId)
        }

        // 3. 🔥 PARALLEL EXECUTION (All 3 queries run at exactly the same time)
        const [papersRes, docsRes, notifsRes] = await Promise.all([
          papersQuery.order('created_at', { ascending: false }),
          docsQuery.order('created_at', { ascending: false }),
          supabase.from('notifications').select('*').contains('target_roles', [userData.role]).limit(30)
        ])

        const safeJobs = [...(papersRes.data || []), ...(docsRes.data || [])]
        const safeNotifs = notifsRes.data || []

        // 4. Shape the data EXACTLY as index.html expects it
        return {
          success: true,
          profile: {
            id: userData.id,
            instId: userData.institute_id || '',
            email: userData.email, 
            name: userData.full_name, 
            role: userData.role, 
            subjects: userData.subjects || userData.operator_profiles?.[0]?.subjects || 'Not Assigned',
            institute: userData.institutes?.institute_name || '', 
            code: userData.institutes?.institute_code || userData.institutes?.code || '',
            logo: userData.institutes?.logo_url || userData.institutes?.logo || '', 
            profilePic: userData.profile_pic_url,
            toggles: {
                attendance: userData.institutes?.attendance_toggle ? "YES" : "NO",
                admission: userData.institutes?.admission_toggle ? "YES" : "NO",
                fee: userData.institutes?.fee_toggle ? "YES" : "NO"
            },
            instDetails: userData.institutes || {}
          },
          data: {
            papers: safeJobs.filter(j => j.job_type === 'Paper').map(j => ({ 
                id: j.job_code, date: j.created_at, 
                inst: userData.institutes?.institute_name || 'Unknown', 
                class: j.meta_data?.class || '', subject: j.meta_data?.subject || '', 
                exam: j.meta_data?.test_type || '', deadline: j.deadline || 'No Deadline', 
                status: j.status, row: j.final_file_url || j.raw_file_url || '' 
            })),
            docs: safeJobs.filter(j => j.job_type !== 'Paper').map(j => ({ 
                id: j.job_code, date: j.created_at, 
                inst: userData.institutes?.institute_name || 'Unknown', 
                class: j.meta_data?.class || '', type: j.job_type, 
                exam: j.meta_data?.exam_name || '', students: j.meta_data?.num_students || 0, 
                deadline: j.deadline || 'No Deadline', status: j.status, 
                row: j.final_file_url || j.raw_file_url || '' 
            }))
          },
          notifications: safeNotifs.map(n => ({ title: n.title, msg: n.message, time: n.created_at, isRead: false })),
          stats: {
             academic: { today: safeJobs.filter(j => j.status === 'Pending').length, session: safeJobs.length, academic: safeJobs.length },
             inst: { month: safeJobs.length, academic: safeJobs.length },
             financial: { total: 0, pending: 0 }
          }
        }
      },

      // ===============================
      // 📄 CREATE JOB (OPTIMIZED & PARALLEL)
      // ===============================
      submitPaperJob: async () => {

        // 1. Fetch User & Inst in ONE query
        const { data: dbUser } = await supabase
          .from('users')
          .select('id, institute_id, institutes (institute_code, institute_name)')
          .eq('auth_user_id', userContext.id)
          .single()

        const instData = Array.isArray(dbUser.institutes) ? dbUser.institutes[0] : dbUser.institutes;
        const instCode = instData?.institute_code || "TK";
        const instName = instData?.institute_name || "Unknown Inst";

        const jobTypeStr = payload.jobType || "Paper"
        const jobId = `${instCode}-${Date.now()}`

        // 2. 🔥 PARALLEL EXECUTION: Upload to Drive AND Search for Operator simultaneously!
        
        // Task A: Google Drive Upload
        const uploadTask = async () => {
          if (!payload.fileBase64) return "";
          // (Assuming deep routing is handled inside getOrCreateFolder if needed, else base folder)
          let folderId = await getOrCreateFolder(instName); 
          if(jobTypeStr === "Paper") {
              folderId = await getOrCreateFolder('Uploads_from_Teachers', folderId);
          } else {
              folderId = await getOrCreateFolder('Documents_Upload', folderId);
          }
          let ext = payload.mimeType === "application/pdf" ? ".pdf" : "";
          if (payload.fileName && payload.fileName.includes('.')) ext = '.' + payload.fileName.split('.').pop();
          
          return await uploadToGoogleDrive(payload.fileBase64, jobId + ext, payload.mimeType, folderId);
        }

        // Task B: Auto-Assign Operator
        const assignTask = async () => {
          const { data: ops } = await supabase.from('operator_profiles').select('user_id, work_types, subjects, status');
          if (!ops) return null;
          
          const matches = ops.filter(op => {
             const isActive = (!op.status || op.status === "Active" || op.status === "Connected");
             if (!isActive) return false;

             const safeWork = JSON.stringify(op.work_types || "").toLowerCase();
             const safeSub = JSON.stringify(op.subjects || "").toLowerCase();
             
             const reqWork = jobTypeStr.toLowerCase();
             const handlesWork = safeWork.includes(reqWork) || safeWork.includes("paper format");
             
             let handlesSub = true;
             if (payload.subject) {
                 const reqSub = payload.subject.toLowerCase();
                 handlesSub = safeSub.includes(reqSub) || (reqSub === 'mathematics' && safeSub.includes('math'));
             }
             return handlesWork && handlesSub;
          });

          if (matches.length > 0) {
             return matches[Math.floor(Math.random() * matches.length)].user_id;
          }
          return null;
        }

        // Wait for both tasks to finish at the same time
        const [fileUrl, assignedOperatorId] = await Promise.all([uploadTask(), assignTask()]);

        // 3. Insert Fast
        await supabase.from('jobs_queue').insert([{
          job_code: jobId,
          job_type: jobTypeStr,
          institute_id: dbUser.institute_id,
          requester_id: dbUser.id,
          operator_id: assignedOperatorId, // Stamped perfectly
          status: "Pending",
          raw_file_url: fileUrl,
          meta_data: {
             ...payload,
             subject: payload.subject || "N/A"
          }
        }])

        return { success: true, jobId }
      },

      // ===============================
      // 🔔 NOTIFICATION
      // ===============================
      sendNotification: async () => {
        await supabase.from('notifications').insert([{
          sender_id: userContext.id,
          title: payload.title,
          message: payload.msg,
          target_roles: [payload.targetRaw]
        }])
        return { success: true }
      }

    }

    // ===============================
    // 🚀 EXECUTE ACTION
    // ===============================
    if (!handlers[action]) throw new Error("Invalid action: " + action)

    const result = await handlers[action]()

    // ===============================
    // ⚡ PERFORMANCE LOG
    // ===============================
    console.log(`⚡ ${action} executed in ${Date.now() - startTime}ms`)

    return res.status(200).json(result)

  } catch (err) {
    console.error("🔥 ERROR:", err.message)
    return res.status(200).json({ success: false, message: err.message })
  }
}
