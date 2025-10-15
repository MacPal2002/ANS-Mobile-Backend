import * as httpFunctions from "./http";
import * as schedulerFunctions from "./scheduler";
import * as tasksFunctions from "./tasks";


export const httpJobs = {...httpFunctions};
export const scheduledJobs = {...schedulerFunctions};
export const tasksJobs = {...tasksFunctions};

